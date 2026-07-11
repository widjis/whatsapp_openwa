import axios from 'axios';
import { Redis as IORedis } from 'ioredis';
import crypto from 'node:crypto';
import path from 'node:path';
import OpenAI from 'openai';
import {
  getAllRequests,
  updateRequest,
  viewRequest,
  type ServiceDeskRequest,
} from '../integrations/ticketHandle.js';
import {
  getContactByIctTechnicianName,
  listTechnicianContacts,
  type TechnicianContact,
} from '../integrations/technicianContacts.js';
import {
  buildLeaveScheduleIndexForDate,
  getTodayIsoDateForOffsetHours,
  resolveLeaveScheduleEntry,
} from '../../leaveScheduleCheck.js';

type NotifyMode = 'none' | 'direct' | 'digest';

type DispatcherConfig = {
  enabled: boolean;
  scanIntervalSeconds: number;
  runOnce: boolean;
  dryRun: boolean;
  dryRunIgnoreRedisState: boolean;
  enforceTemplate: boolean;
  requiredTemplateId: string;
  requiredTemplateName: string;
  requiredTemplateIsService: boolean;
  minAgeHours: number;
  maxAgeHours: number;
  maxTicketsPerRun: number;
  maxAssignmentsPerRun: number;
  notifyMode: NotifyMode;
  notifyMaxPerRun: number;
  gatewayBaseUrl: string;
  digestNumbers: string[];
  logActions: boolean;
  logActionsMax: number;
  aiRoutingEnabled: boolean;
  aiRoutingConfidenceThreshold: number;
  aiRoutingModel: string;
  manualOverrideBackoffHours: number;
  reminderMode: NotifyMode;
  remindUnassignedAfterHours: number;
  remindUnpickedIctAfterHours: number;
  remindAssignedOpenAfterHours: number;
  reminderCooldownHours: number;
  reminderMaxPerRun: number;
  digestScheduleHours: number[];
  digestTimeZone: string;
  digestMaxItems: number;
  digestAgeBucketsHours: number[];
  ictExclude: Set<string>;
  ictWeightsByName: Map<string, number>;
  ictMaxOpenByName: Map<string, number>;
  groupNames: {
    itSupport: string;
    itField: string;
    docControl: string;
    triage: string;
  };
  closedStatuses: string[];
  lockTtlSeconds: number;
  leaveScheduleEnabled: boolean;
  leaveScheduleXlsxPath: string;
  leaveScheduleSheetName: string;
  leaveScheduleTzOffsetHours: number;
  leaveScheduleDateShiftDays: number;
  leaveScheduleAllowFuzzy: boolean;
  leaveScheduleSimilarityThreshold: number;
};

type LeaveStatus = {
  found: boolean;
  onsite: boolean;
  status: string | null;
  matchedKey: string | null;
};

type LeaveStatusByIctName = Map<string, LeaveStatus>;

type DispatcherTicketState = {
  ticketId: string;
  lastActionAtIso?: string;
  lastAssignedGroupName?: string | null;
  lastAssignedIctTechnician?: string | null;
  lastNotifiedHash?: string | null;
  lastReminderAtIso?: string | null;
  lastReminderHash?: string | null;
};

type ScanStats = {
  scanned: number;
  matched: number;
  assigned: number;
  notified: number;
  skipped: number;
  errors: number;
};

type AssignmentLogItem = {
  ticketId: string;
  link: string;
  reason: string;
  fromTemplate: string;
  toTemplate: string;
  fromGroup: string;
  toGroup: string;
  fromIctTechnician: string;
  toIctTechnician: string;
  toIctLoad: number;
  applied: boolean;
  applyError: string | null;
  verified: boolean;
  afterTemplate: string;
  afterGroup: string;
  afterIctTechnician: string;
};

type ReminderLogItem = {
  ticketId: string;
  kind: 'unassigned' | 'unpicked_ict' | 'assigned_open';
  target: string;
  link: string;
  reason: string;
};

type ScanRunResult = {
  stats: ScanStats;
  assignments: AssignmentLogItem[];
  reminders: ReminderLogItem[];
  digestPreview: string | null;
};

type AiRouteDecision = {
  routeKey: 'doc_control' | 'it_support' | 'it_field' | 'triage';
  confidence: number;
  reason: string;
};

const inMemoryStates = new Map<string, DispatcherTicketState>();
let redisClient: IORedis | null | undefined;
let redisConnectPromise: Promise<void> | null = null;

function getOptionalEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = getOptionalEnv(name);
  if (!raw) return defaultValue;
  const v = raw.toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return defaultValue;
}

function parseNumberEnv(name: string, defaultValue: number): number {
  const raw = getOptionalEnv(name);
  if (!raw) return defaultValue;
  const value = Number(raw);
  return Number.isFinite(value) ? value : defaultValue;
}

function parseNotifyMode(raw: string | undefined): NotifyMode {
  if (!raw) return 'none';
  const v = raw.trim().toLowerCase();
  if (v === 'direct' || v === 'digest' || v === 'none') return v;
  return 'none';
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function parseNumberListCsv(raw: string | undefined): number[] {
  return parseCsv(raw)
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
}

function parseKeyValueNumberMap(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of parseCsv(raw)) {
    const parts = entry.includes('=') ? entry.split('=') : entry.split(':');
    const key = (parts[0] ?? '').trim();
    const valueRaw = (parts[1] ?? '').trim();
    const value = Number(valueRaw);
    if (!key) continue;
    if (!Number.isFinite(value)) continue;
    out.set(key, value);
  }
  return out;
}

function computeServiceDeskHostBaseUrl(): string {
  const rawApiBase = process.env.SD_BASE_URL ?? '';
  const apiBaseUrl = rawApiBase.endsWith('/') ? rawApiBase.slice(0, -1) : rawApiBase;
  return apiBaseUrl.endsWith('/api/v3') ? apiBaseUrl.slice(0, -'/api/v3'.length) : apiBaseUrl;
}

function buildTicketLink(ticketId: string): string {
  const hostBaseUrl = computeServiceDeskHostBaseUrl();
  const base = hostBaseUrl.endsWith('/') ? hostBaseUrl.slice(0, -1) : hostBaseUrl;
  return `${base}/WorkOrder.do?woMode=viewWO&woID=${encodeURIComponent(ticketId)}`;
}

function buildConfig(): DispatcherConfig {
  const enabled = parseBooleanEnv('DISPATCHER_ENABLED', false);
  const scanIntervalSeconds = Math.max(10, Math.floor(parseNumberEnv('DISPATCHER_SCAN_INTERVAL_SECONDS', 300)));
  const runOnce = parseBooleanEnv('DISPATCHER_RUN_ONCE', false);
  const dryRun = parseBooleanEnv('DISPATCHER_DRY_RUN', true);
  const dryRunIgnoreRedisState = parseBooleanEnv('DISPATCHER_DRY_RUN_IGNORE_REDIS', false);
  const enforceTemplate = parseBooleanEnv('DISPATCHER_ENFORCE_TEMPLATE', true);
  const requiredTemplateId = getOptionalEnv('DISPATCHER_REQUIRED_TEMPLATE_ID') ?? '305';
  const requiredTemplateName = getOptionalEnv('DISPATCHER_REQUIRED_TEMPLATE_NAME') ?? 'Submit a New Request';
  const requiredTemplateIsService = parseBooleanEnv('DISPATCHER_REQUIRED_TEMPLATE_IS_SERVICE', false);
  const minAgeHours = Math.max(0, Math.floor(parseNumberEnv('DISPATCHER_MIN_AGE_HOURS', 0)));
  const maxAgeHours = Math.max(1, Math.floor(parseNumberEnv('DISPATCHER_MAX_AGE_HOURS', 24)));
  const maxTicketsPerRun = Math.max(1, Math.floor(parseNumberEnv('DISPATCHER_MAX_TICKETS_PER_RUN', 100)));
  const maxAssignmentsPerRun = Math.max(0, Math.floor(parseNumberEnv('DISPATCHER_MAX_ASSIGNMENTS_PER_RUN', 20)));
  const notifyMode = parseNotifyMode(getOptionalEnv('DISPATCHER_NOTIFY_MODE'));
  const notifyMaxPerRun = Math.max(0, Math.floor(parseNumberEnv('DISPATCHER_NOTIFY_MAX_PER_RUN', 5)));
  const gatewayBaseUrl = (getOptionalEnv('DISPATCHER_GATEWAY_BASE_URL') ?? 'http://127.0.0.1:8192').replace(/\/$/, '');
  const digestNumbers = parseCsv(getOptionalEnv('DISPATCHER_DIGEST_NUMBERS'));
  const logActions = parseBooleanEnv('DISPATCHER_LOG_ACTIONS', runOnce);
  const logActionsMax = Math.max(1, Math.floor(parseNumberEnv('DISPATCHER_LOG_ACTIONS_MAX', 50)));

  const aiRoutingEnabled = parseBooleanEnv('DISPATCHER_AI_ROUTING_ENABLED', false);
  const aiRoutingConfidenceThreshold = Math.min(1, Math.max(0, parseNumberEnv('DISPATCHER_AI_CONFIDENCE_THRESHOLD', 0.8)));
  const aiRoutingModel = getOptionalEnv('DISPATCHER_AI_MODEL') ?? 'gpt-4o-mini';

  const manualOverrideBackoffHours = Math.max(0, Math.floor(parseNumberEnv('DISPATCHER_MANUAL_OVERRIDE_BACKOFF_HOURS', 24)));

  const reminderMode = parseNotifyMode(getOptionalEnv('DISPATCHER_REMINDER_MODE') ?? notifyMode);
  const remindUnassignedAfterHours = Math.max(0, parseNumberEnv('DISPATCHER_REMIND_UNASSIGNED_AFTER_HOURS', 0));
  const remindUnpickedIctAfterHours = Math.max(0, parseNumberEnv('DISPATCHER_REMIND_UNPICKED_ICT_AFTER_HOURS', 0));
  const remindAssignedOpenAfterHours = Math.max(0, parseNumberEnv('DISPATCHER_REMIND_ASSIGNED_OPEN_AFTER_HOURS', 0));
  const reminderCooldownHours = Math.max(0, parseNumberEnv('DISPATCHER_REMINDER_COOLDOWN_HOURS', 12));
  const reminderMaxPerRun = Math.max(0, Math.floor(parseNumberEnv('DISPATCHER_REMINDER_MAX_PER_RUN', 5)));

  const digestScheduleHours = parseNumberListCsv(getOptionalEnv('DISPATCHER_DIGEST_SCHEDULE_HOURS')).filter((h) => h >= 0 && h <= 23);
  const digestTimeZone = getOptionalEnv('DISPATCHER_DIGEST_TIMEZONE') ?? 'Asia/Makassar';
  const digestMaxItems = Math.max(0, Math.floor(parseNumberEnv('DISPATCHER_DIGEST_MAX_ITEMS', 20)));
  const digestAgeBucketsHours = parseNumberListCsv(getOptionalEnv('DISPATCHER_DIGEST_AGE_BUCKETS_HOURS') ?? '6,24,72')
    .filter((h) => h > 0)
    .sort((a, b) => a - b);

  const ictExclude = new Set(parseCsv(getOptionalEnv('DISPATCHER_ICT_EXCLUDE')));
  const ictWeightsByName = parseKeyValueNumberMap(getOptionalEnv('DISPATCHER_ICT_WEIGHTS'));
  const ictMaxOpenByName = parseKeyValueNumberMap(getOptionalEnv('DISPATCHER_ICT_MAX_OPEN'));

  const closedStatusesRaw = getOptionalEnv('DISPATCHER_CLOSED_STATUSES');
  const closedStatuses = (closedStatusesRaw ? parseCsv(closedStatusesRaw) : ['Resolved', 'Closed']).map((s) => s.toLowerCase());

  const lockTtlSeconds = Math.max(30, Math.floor(parseNumberEnv('DISPATCHER_LOCK_TTL_SECONDS', 90)));

  const leaveScheduleEnabled = parseBooleanEnv('DISPATCHER_LEAVE_SCHEDULE_ENABLED', false);
  const dataDir = process.env.DATA_DIR && process.env.DATA_DIR.trim().length > 0 ? process.env.DATA_DIR.trim() : path.resolve(process.cwd(), 'data');
  const leaveScheduleXlsxPath =
    getOptionalEnv('DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH') ?? path.join(dataDir, 'MTI - Leave Schedule (ICT Team).xlsx');
  const leaveScheduleSheetName = getOptionalEnv('DISPATCHER_LEAVE_SCHEDULE_SHEET') ?? 'Human Resource';
  const leaveScheduleTzOffsetHours = Math.floor(parseNumberEnv('DISPATCHER_LEAVE_SCHEDULE_TZ_OFFSET_HOURS', 8));
  const leaveScheduleDateShiftDays = Math.floor(parseNumberEnv('DISPATCHER_LEAVE_SCHEDULE_DATE_SHIFT_DAYS', 1));
  const leaveScheduleAllowFuzzy = parseBooleanEnv('DISPATCHER_LEAVE_SCHEDULE_FUZZY', true);
  const leaveScheduleSimilarityThreshold = Math.min(1, Math.max(0, parseNumberEnv('DISPATCHER_LEAVE_SCHEDULE_SIM_THRESHOLD', 0.9)));

  const groupNames = {
    docControl: getOptionalEnv('DISPATCHER_GROUP_DOC_CONTROL') ?? 'Document Control',
    itSupport: getOptionalEnv('DISPATCHER_GROUP_IT_SUPPORT') ?? 'IT Support',
    itField: getOptionalEnv('DISPATCHER_GROUP_IT_FIELD') ?? 'IT Field Support',
    triage: getOptionalEnv('DISPATCHER_GROUP_TRIAGE') ?? 'IT Support',
  };

  return {
    enabled,
    scanIntervalSeconds,
    runOnce,
    dryRun,
    dryRunIgnoreRedisState,
    enforceTemplate,
    requiredTemplateId,
    requiredTemplateName,
    requiredTemplateIsService,
    minAgeHours,
    maxAgeHours,
    maxTicketsPerRun,
    maxAssignmentsPerRun,
    notifyMode,
    notifyMaxPerRun,
    gatewayBaseUrl,
    digestNumbers,
    logActions,
    logActionsMax,
    aiRoutingEnabled,
    aiRoutingConfidenceThreshold,
    aiRoutingModel,
    manualOverrideBackoffHours,
    reminderMode,
    remindUnassignedAfterHours,
    remindUnpickedIctAfterHours,
    remindAssignedOpenAfterHours,
    reminderCooldownHours,
    reminderMaxPerRun,
    digestScheduleHours,
    digestTimeZone,
    digestMaxItems,
    digestAgeBucketsHours,
    ictExclude,
    ictWeightsByName,
    ictMaxOpenByName,
    groupNames,
    closedStatuses,
    lockTtlSeconds,
    leaveScheduleEnabled,
    leaveScheduleXlsxPath,
    leaveScheduleSheetName,
    leaveScheduleTzOffsetHours,
    leaveScheduleDateShiftDays,
    leaveScheduleAllowFuzzy,
    leaveScheduleSimilarityThreshold,
  };
}

function getRedisClient(): IORedis | null {
  if (redisClient !== undefined) return redisClient;

  const host = getOptionalEnv('REDIS_HOST');
  const portRaw = getOptionalEnv('REDIS_PORT');
  if (!host || !portRaw) {
    redisClient = null;
    return null;
  }

  const port = Number(portRaw);
  if (!Number.isFinite(port)) {
    redisClient = null;
    return null;
  }

  const client = new IORedis({ host, port, lazyConnect: true, maxRetriesPerRequest: 1 });
  client.on('error', (err: Error) => {
    console.error('Redis error:', err);
  });
  redisClient = client;
  return client;
}

async function ensureRedisConnected(redis: IORedis): Promise<void> {
  if (redis.status === 'ready') return;
  if (!redisConnectPromise) {
    redisConnectPromise = redis.connect().catch((error: unknown) => {
      redisConnectPromise = null;
      throw error;
    });
  }
  await redisConnectPromise;
}

function stateKey(ticketId: string): string {
  return `dispatcher_ticket:${ticketId}`;
}

function scanLockKey(): string {
  return 'dispatcher_scan_lock:helpdesk';
}

function digestSentKey(dateKey: string, hour: number): string {
  return `dispatcher_digest_sent:${dateKey}:${hour}`;
}

function getZonedDateKeyAndHour(timeZone: string, date: Date): { dateKey: string; hour: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);

    const y = parts.find((p) => p.type === 'year')?.value ?? '';
    const m = parts.find((p) => p.type === 'month')?.value ?? '';
    const d = parts.find((p) => p.type === 'day')?.value ?? '';
    const h = parts.find((p) => p.type === 'hour')?.value ?? '';

    const hour = Number(h);
    if (!y || !m || !d) return null;
    if (!Number.isFinite(hour)) return null;
    return { dateKey: `${y}-${m}-${d}`, hour };
  } catch {
    return null;
  }
}

async function tryMarkDigestSent(key: string): Promise<boolean> {
  const redis = getRedisClient();
  if (redis) {
    try {
      await ensureRedisConnected(redis);
      const result = await redis.set(key, '1', 'PX', 26 * 60 * 60 * 1000, 'NX');
      return result === 'OK';
    } catch {
      return false;
    }
  }

  if (inMemoryStates.has(key)) return false;
  inMemoryStates.set(key, { ticketId: key, lastActionAtIso: new Date().toISOString() });
  return true;
}

async function acquireScanLock(ttlSeconds: number): Promise<string | null> {
  const token = crypto.randomUUID();
  const redis = getRedisClient();
  if (redis) {
    try {
      await ensureRedisConnected(redis);
      const result = await redis.set(scanLockKey(), token, 'PX', ttlSeconds * 1000, 'NX');
      return result === 'OK' ? token : null;
    } catch {
      return token;
    }
  }

  if (inMemoryStates.has(scanLockKey())) return null;
  inMemoryStates.set(scanLockKey(), { ticketId: scanLockKey(), lastActionAtIso: token });
  setTimeout(() => {
    const current = inMemoryStates.get(scanLockKey());
    if (current?.lastActionAtIso === token) inMemoryStates.delete(scanLockKey());
  }, ttlSeconds * 1000).unref();
  return token;
}

async function releaseScanLock(token: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try {
      await ensureRedisConnected(redis);
      const raw = await redis.get(scanLockKey());
      if (raw === token) await redis.del(scanLockKey());
      return;
    } catch {
      return;
    }
  }

  const current = inMemoryStates.get(scanLockKey());
  if (current?.lastActionAtIso === token) inMemoryStates.delete(scanLockKey());
}

async function loadTicketState(ticketId: string): Promise<DispatcherTicketState | null> {
  const redis = getRedisClient();
  if (redis) {
    try {
      await ensureRedisConnected(redis);
      const raw = await redis.get(stateKey(ticketId));
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const r = parsed as Record<string, unknown>;
      const t = typeof r.ticketId === 'string' ? r.ticketId : '';
      if (!t) return null;
      const lastActionAtIso = typeof r.lastActionAtIso === 'string' ? r.lastActionAtIso : undefined;
      const lastAssignedGroupName = typeof r.lastAssignedGroupName === 'string' ? r.lastAssignedGroupName : r.lastAssignedGroupName === null ? null : undefined;
      const lastAssignedIctTechnician =
        typeof r.lastAssignedIctTechnician === 'string'
          ? r.lastAssignedIctTechnician
          : r.lastAssignedIctTechnician === null
            ? null
            : undefined;
      const lastNotifiedHash = typeof r.lastNotifiedHash === 'string' ? r.lastNotifiedHash : r.lastNotifiedHash === null ? null : undefined;
      const lastReminderAtIso = typeof r.lastReminderAtIso === 'string' ? r.lastReminderAtIso : r.lastReminderAtIso === null ? null : undefined;
      const lastReminderHash = typeof r.lastReminderHash === 'string' ? r.lastReminderHash : r.lastReminderHash === null ? null : undefined;
      return {
        ticketId: t,
        lastActionAtIso,
        lastAssignedGroupName,
        lastAssignedIctTechnician,
        lastNotifiedHash,
        lastReminderAtIso,
        lastReminderHash,
      };
    } catch {
      return inMemoryStates.get(ticketId) ?? null;
    }
  }

  return inMemoryStates.get(ticketId) ?? null;
}

async function saveTicketState(state: DispatcherTicketState): Promise<void> {
  inMemoryStates.set(state.ticketId, state);
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await ensureRedisConnected(redis);
    await redis.set(stateKey(state.ticketId), JSON.stringify(state), 'EX', 60 * 60 * 24 * 14);
  } catch {
    return;
  }
}

function normalizeText(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isKnownGroupName(config: DispatcherConfig, groupName: string): boolean {
  const q = groupName.trim().toLowerCase();
  if (!q) return false;
  const candidates = [config.groupNames.docControl, config.groupNames.itSupport, config.groupNames.itField, config.groupNames.triage]
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);
  return candidates.includes(q);
}

function resolveEffectiveGroupName(config: DispatcherConfig, requestObj: ServiceDeskRequest): string {
  const fromTechnician = normalizeText(requestObj.technician?.name);
  if (fromTechnician && isKnownGroupName(config, fromTechnician)) return fromTechnician;
  return normalizeText(requestObj.group?.name);
}

function parseCreatedAt(requestObj: ServiceDeskRequest): Date | null {
  const raw = requestObj.created_time?.display_value;
  if (!raw) return null;
  const dt = new Date(raw);
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function getTicketAgeHours(requestObj: ServiceDeskRequest): number | null {
  const createdAt = parseCreatedAt(requestObj);
  if (!createdAt) return null;
  const ageMs = Date.now() - createdAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  return ageMs / (60 * 60 * 1000);
}

function hoursSinceIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const dt = new Date(iso);
  if (!Number.isFinite(dt.getTime())) return null;
  const deltaMs = Date.now() - dt.getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  return deltaMs / (60 * 60 * 1000);
}

function isClosedStatus(config: DispatcherConfig, requestObj: ServiceDeskRequest): boolean {
  const status = normalizeText(requestObj.status?.name).toLowerCase();
  if (!status) return false;
  return config.closedStatuses.includes(status);
}

function shouldConsiderByAge(config: DispatcherConfig, requestObj: ServiceDeskRequest): boolean {
  const createdAt = parseCreatedAt(requestObj);
  if (!createdAt) return false;
  const ageMs = Date.now() - createdAt.getTime();
  const minAgeMs = config.minAgeHours * 60 * 60 * 1000;
  const maxAgeMs = config.maxAgeHours * 60 * 60 * 1000;
  return ageMs >= minAgeMs && ageMs <= maxAgeMs;
}

type RouteDecision = {
  routeKey: 'doc_control' | 'it_support' | 'it_field' | 'triage';
  targetGroupName: string;
  reason: string;
};

function routeTicketHeuristic(config: DispatcherConfig, requestObj: ServiceDeskRequest): RouteDecision {
  const subject = normalizeText(requestObj.subject);
  const desc = normalizeText(requestObj.description);
  const category = normalizeText(requestObj.service_category?.name);
  const combined = `${subject}\n${desc}\n${category}`.toLowerCase();

  const hasAny = (needles: string[]) => needles.some((k) => combined.includes(k));

  if (
    hasAny(['srf', 'service request form', 'approval', 'document control', 'document', 'scan', 'archive', 'sop', 'procedure'])
  ) {
    return { routeKey: 'doc_control', targetGroupName: config.groupNames.docControl, reason: 'keyword_match:doc_control' };
  }

  if (
    hasAny([
      'network',
      'switch',
      'access point',
      'wifi',
      'lan',
      'cable',
      'cabling',
      'ip address',
      'cctv',
      'camera',
      'nvr',
      'radio',
      'ht',
      'deskphone',
      'printer network',
    ])
  ) {
    return { routeKey: 'it_field', targetGroupName: config.groupNames.itField, reason: 'keyword_match:it_field' };
  }

  if (
    hasAny([
      'password',
      'reset',
      'email',
      'outlook',
      'office',
      'excel',
      'word',
      'powerpoint',
      'laptop',
      'pc',
      'windows',
      'printer',
      'scanner',
      'application',
      'software',
    ])
  ) {
    return { routeKey: 'it_support', targetGroupName: config.groupNames.itSupport, reason: 'keyword_match:it_support' };
  }

  return { routeKey: 'triage', targetGroupName: config.groupNames.triage, reason: 'default:triage' };
}

function mapRouteKeyToGroup(config: DispatcherConfig, routeKey: RouteDecision['routeKey']): string {
  if (routeKey === 'doc_control') return config.groupNames.docControl;
  if (routeKey === 'it_field') return config.groupNames.itField;
  if (routeKey === 'it_support') return config.groupNames.itSupport;
  return config.groupNames.triage;
}

function getOpenAiClient(): OpenAI {
  const apiKey = getOptionalEnv('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY must be set in environment');
  return new OpenAI({ apiKey });
}

function safeParseAiRouteDecision(raw: string): AiRouteDecision | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const tryParse = (input: string): unknown => JSON.parse(input);

  let parsed: unknown;
  try {
    parsed = tryParse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      parsed = tryParse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;

  const routeKey = r.routeKey;
  const confidence = r.confidence;
  const reason = r.reason;

  const isRouteKey =
    routeKey === 'doc_control' || routeKey === 'it_support' || routeKey === 'it_field' || routeKey === 'triage';
  if (!isRouteKey) return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  if (typeof reason !== 'string') return null;
  return { routeKey, confidence, reason };
}

async function routeTicket(config: DispatcherConfig, requestObj: ServiceDeskRequest): Promise<RouteDecision> {
  const heuristicWithFallback = (fallback: string): RouteDecision => {
    const h = routeTicketHeuristic(config, requestObj);
    return { ...h, reason: `ai_fallback:${fallback}|${h.reason}` };
  };

  if (!config.aiRoutingEnabled) return routeTicketHeuristic(config, requestObj);
  if (!getOptionalEnv('OPENAI_API_KEY')) return heuristicWithFallback('missing_key');

  const subject = normalizeText(requestObj.subject);
  const desc = normalizeText(requestObj.description);
  const category = normalizeText(requestObj.service_category?.name);

  const prompt = [
    'You are routing helpdesk tickets into exactly one routeKey:',
    '- "it_support"',
    '- "it_field"',
    '- "doc_control"',
    '- "triage" (use only when unclear / insufficient information)',
    '',
    'Return ONLY valid JSON with this schema:',
    '{"routeKey":"triage","confidence":0.0,"reason":"short"}',
    '',
    'Rules:',
    '- confidence must be a number 0..1',
    '- reason must be short (max 12 words)',
    '- choose the best match using the routing policy below',
    '',
    'Routing policy:',
    '- it_support: PC/Laptop problems, Windows, peripherals (mouse/keyboard/charger), LED monitor, Office apps (Excel/Word/PowerPoint/Outlook), printer/scanner, Merdeka internal apps (workflow/joget/pronto), file server/shared folder, system & mail.',
    '- it_field: network/WiFi/LAN/cabling/switch/router/VPN/IP, CCTV/camera/NVR, Radio HT, deskphone/PABX, television/TV, access card/RFID, and any field/on-site/network work.',
    '- doc_control: administration, document register, document control, scanning/archiving, SOP/procedure, simcard request, and related document operations.',
    '- triage: only if subject/description is too vague to decide confidently.',
    '',
    `Subject: ${subject}`,
    `Category: ${category}`,
    `Description: ${desc}`,
  ].join('\n');

  try {
    const openai = getOpenAiClient();
    const chatCompletion = await openai.chat.completions.create({
      model: config.aiRoutingModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 120,
    });
    const content = chatCompletion.choices[0]?.message?.content ?? '';
    const ai = safeParseAiRouteDecision(content);
    if (!ai) return heuristicWithFallback('parse_fail');
    if (ai.confidence < config.aiRoutingConfidenceThreshold) {
      const conf = Math.round(ai.confidence * 1000) / 1000;
      const threshold = Math.round(config.aiRoutingConfidenceThreshold * 1000) / 1000;
      return {
        routeKey: 'triage',
        targetGroupName: mapRouteKeyToGroup(config, 'triage'),
        reason: `ai_low_conf(conf=${conf},th=${threshold})|triage`,
      };
    }
    return {
      routeKey: ai.routeKey,
      targetGroupName: mapRouteKeyToGroup(config, ai.routeKey),
      reason: `ai:${ai.reason}`,
    };
  } catch {
    return heuristicWithFallback('exception');
  }
}

function resolveContactsForGroup(args: { targetGroupName: string; contacts: TechnicianContact[] }): TechnicianContact[] {
  const targetGroupName = args.targetGroupName;
  const q = targetGroupName.trim().toLowerCase();
  if (!q) return [];
  return args.contacts.filter((c) => c.technician.trim().toLowerCase().includes(q));
}

function groupKey(groupName: string): string {
  return groupName.trim().toLowerCase();
}

function hashToUint32(input: string): number {
  const buf = crypto.createHash('sha256').update(input).digest();
  return buf.readUInt32BE(0);
}

function pickIctTechnicianByLoad(args: {
  config: DispatcherConfig;
  ticketId: string;
  groupName: string;
  contacts: TechnicianContact[];
  loadByGroupIct: Map<string, Map<string, number>>;
  leaveStatusByIctName: LeaveStatusByIctName | null;
}): TechnicianContact | null {
  const groupContacts = resolveContactsForGroup({ targetGroupName: args.groupName, contacts: args.contacts });
  if (groupContacts.length === 0) return null;

  const loadByIctTechnician = args.loadByGroupIct.get(groupKey(args.groupName)) ?? new Map<string, number>();

  let best: TechnicianContact | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestTie = Number.POSITIVE_INFINITY;

  for (const c of groupContacts) {
    if (args.config.ictExclude.has(c.ict_name)) continue;
    if (args.leaveStatusByIctName) {
      const leave = args.leaveStatusByIctName.get(c.ict_name);
      if (!leave || !leave.found || !leave.onsite) continue;
    }
    const load = loadByIctTechnician.get(c.ict_name) ?? 0;
    const maxOpen = args.config.ictMaxOpenByName.get(c.ict_name);
    if (typeof maxOpen === 'number' && Number.isFinite(maxOpen) && load >= maxOpen) continue;

    const weightRaw = args.config.ictWeightsByName.get(c.ict_name) ?? 1;
    const weight = weightRaw > 0 ? weightRaw : 1;
    const score = load / weight;
    const tie = hashToUint32(`${args.ticketId}|${c.ict_name}`) / 2 ** 32;

    if (score < bestScore) {
      best = c;
      bestScore = score;
      bestTie = tie;
      continue;
    }
    if (score === bestScore && tie < bestTie) {
      best = c;
      bestTie = tie;
    }
  }

  return best;
}

function buildNotificationMessage(args: {
  ticketId: string;
  subject: string;
  status: string;
  priority: string;
  groupName: string;
  requester: string;
  createdAt: string;
  reason: string;
}): string {
  const link = buildTicketLink(args.ticketId);
  const lines: string[] = [];
  lines.push('*Ticket needs assignment*');
  lines.push(`Ticket ID: ${args.ticketId}`);
  lines.push(`Group: ${args.groupName}`);
  if (args.status) lines.push(`Status: ${args.status}`);
  if (args.priority) lines.push(`Priority: ${args.priority}`);
  if (args.requester) lines.push(`Requester: ${args.requester}`);
  if (args.createdAt) lines.push(`Created: ${args.createdAt}`);
  if (args.subject) lines.push(`Subject: ${args.subject}`);
  lines.push(`Link: ${link}`);
  lines.push(`Reason: ${args.reason}`);
  return lines.join('\n');
}

function buildReminderMessage(args: {
  ticketId: string;
  kind: ReminderLogItem['kind'];
  subject: string;
  status: string;
  groupName: string;
  ictTechnician: string;
  ageHours: number;
  reason: string;
}): string {
  const link = buildTicketLink(args.ticketId);
  const lines: string[] = [];
  lines.push('*Ticket reminder*');
  lines.push(`Ticket ID: ${args.ticketId}`);
  if (args.kind) lines.push(`Kind: ${args.kind}`);
  if (args.groupName) lines.push(`Group: ${args.groupName}`);
  if (args.ictTechnician) lines.push(`ICT: ${args.ictTechnician}`);
  if (args.status) lines.push(`Status: ${args.status}`);
  if (args.subject) lines.push(`Subject: ${args.subject}`);
  lines.push(`Age: ${Math.floor(args.ageHours)}h`);
  lines.push(`Link: ${link}`);
  lines.push(`Reason: ${args.reason}`);
  return lines.join('\n');
}

async function sendDirectNotifications(args: {
  config: DispatcherConfig;
  phones: string[];
  message: string;
}): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const phone of args.phones) {
    try {
      await axios.post(
        `${args.config.gatewayBaseUrl}/send-message`,
        { number: phone, message: args.message },
        { timeout: 15_000 }
      );
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed };
}

function computeNotificationHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 24);
}

function formatAgeBucketLabel(upperHours: number): string {
  if (upperHours < 24) return `<=${upperHours}h`;
  const days = Math.round((upperHours / 24) * 10) / 10;
  return `<=${days}d`;
}

function resolveAgeBucketIndex(ageHours: number, bucketsHours: number[]): number {
  for (let i = 0; i < bucketsHours.length; i += 1) {
    if (ageHours <= bucketsHours[i]) return i;
  }
  return bucketsHours.length;
}

function buildOperationalDigestMessage(args: {
  config: DispatcherConfig;
  requests: ServiceDeskRequest[];
}): string {
  const { config, requests } = args;
  const buckets = config.digestAgeBucketsHours;
  const bucketLabels = buckets.map((h) => formatAgeBucketLabel(h)).concat(['>' + (buckets.at(-1) ?? 0) + 'h']);

  const groupCounts = new Map<string, number>();
  const groupBucketCounts = new Map<string, number[]>();
  const unassignedItems: Array<{ ticketId: string; ageHours: number; groupName: string; subject: string }> = [];

  for (const r of requests) {
    if (isClosedStatus(config, r)) continue;
    const ageHours = getTicketAgeHours(r);
    if (ageHours === null) continue;
    if (ageHours > config.maxAgeHours) continue;

    const groupName = normalizeText(r.technician?.name) || normalizeText(r.group?.name) || 'Unassigned';
    groupCounts.set(groupName, (groupCounts.get(groupName) ?? 0) + 1);

    const idx = resolveAgeBucketIndex(ageHours, buckets);
    const arr = groupBucketCounts.get(groupName) ?? Array(bucketLabels.length).fill(0);
    arr[idx] = (arr[idx] ?? 0) + 1;
    groupBucketCounts.set(groupName, arr);

    const ict = normalizeText(r.udf_fields?.udf_pick_601);
    const needsAssignment = !normalizeText(r.technician?.name) || !ict;
    if (needsAssignment) {
      unassignedItems.push({
        ticketId: r.id,
        ageHours,
        groupName,
        subject: normalizeText(r.subject) || '-',
      });
    }
  }

  unassignedItems.sort((a, b) => b.ageHours - a.ageHours);

  const lines: string[] = [];
  lines.push('*Dispatcher Digest (Operational)*');
  lines.push(`Open tickets: ${Array.from(groupCounts.values()).reduce((a, b) => a + b, 0)}`);
  lines.push('');
  lines.push('By group:');
  for (const [groupName, count] of Array.from(groupCounts.entries()).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${groupName}: ${count}`);
  }
  lines.push('');
  lines.push('Age buckets:');
  lines.push(bucketLabels.join(' | '));
  for (const [groupName, counts] of Array.from(groupBucketCounts.entries()).sort((a, b) => (groupCounts.get(b[0]) ?? 0) - (groupCounts.get(a[0]) ?? 0))) {
    lines.push(`${groupName}: ${counts.join(' | ')}`);
  }

  const maxList = Math.min(config.digestMaxItems, unassignedItems.length);
  if (maxList > 0) {
    lines.push('');
    lines.push('Top unassigned:');
    for (let i = 0; i < maxList; i += 1) {
      const it = unassignedItems[i];
      lines.push(`${i + 1}. ${it.ticketId} | ${Math.floor(it.ageHours)}h | ${it.groupName} | ${it.subject}`);
    }
  }

  return lines.join('\n');
}

type PlannedAction =
  | {
      kind: 'update';
      ticketId: string;
      targetGroupName?: string;
      targetIctTechnician?: string;
      reason: string;
      notify: boolean;
    }
  | { kind: 'notify_group'; ticketId: string; targetGroupName: string; reason: string }
  | { kind: 'skip'; ticketId: string; reason: string };

async function planAction(args: {
  config: DispatcherConfig;
  requestObj: ServiceDeskRequest;
  contacts: TechnicianContact[];
  loadByGroupIct: Map<string, Map<string, number>>;
  leaveStatusByIctName: LeaveStatusByIctName | null;
}): Promise<PlannedAction> {
  const { config, requestObj, contacts, loadByGroupIct, leaveStatusByIctName } = args;
  const ticketId = requestObj.id;
  const assignedGroupName = normalizeText(requestObj.technician?.name);
  const sdpGroupName = normalizeText(requestObj.group?.name);
  const groupName = assignedGroupName || sdpGroupName;
  const ictTechnician = normalizeText(requestObj.udf_fields?.udf_pick_601);
  const existingTemplate = normalizeText(requestObj.template?.name);

  const isGroupMissing = assignedGroupName.length === 0;
  const isIctTechnicianMissing = ictTechnician.length === 0 || ictTechnician.toLowerCase() === 'ict helpdesk';
  const shouldEnforceTemplate =
    config.enforceTemplate &&
    config.requiredTemplateId.trim().length > 0 &&
    config.requiredTemplateName.trim().length > 0;
  const needsTemplateChange =
    shouldEnforceTemplate &&
    (existingTemplate.length === 0 || existingTemplate.toLowerCase() !== config.requiredTemplateName.trim().toLowerCase());

  if (ictTechnician && isGroupMissing) {
    const contact = getContactByIctTechnicianName(ictTechnician);
    const inferredGroup = normalizeText(contact?.technician);
    if (inferredGroup) {
      return { kind: 'update', ticketId, targetGroupName: inferredGroup, reason: 'infer_group_from_ict_technician', notify: false };
    }
  }

  if (isGroupMissing) {
    if (sdpGroupName) {
      const picked = pickIctTechnicianByLoad({ config, ticketId, groupName: sdpGroupName, contacts, loadByGroupIct, leaveStatusByIctName });
      return {
        kind: 'update',
        ticketId,
        targetGroupName: sdpGroupName,
        targetIctTechnician: isIctTechnicianMissing ? picked?.ict_name : undefined,
        reason: 'mirror_group_to_technician',
        notify: false,
      };
    }

    const decision = await routeTicket(config, requestObj);
    const picked = pickIctTechnicianByLoad({ config, ticketId, groupName: decision.targetGroupName, contacts, loadByGroupIct, leaveStatusByIctName });
    const notify = config.notifyMode === 'direct';
    return {
      kind: 'update',
      ticketId,
      targetGroupName: decision.targetGroupName,
      targetIctTechnician: isIctTechnicianMissing ? picked?.ict_name : undefined,
      reason: decision.reason,
      notify,
    };
  }

  if (isIctTechnicianMissing && groupName) {
    const picked = pickIctTechnicianByLoad({ config, ticketId, groupName, contacts, loadByGroupIct, leaveStatusByIctName });
    if (picked) return { kind: 'update', ticketId, targetIctTechnician: picked.ict_name, reason: 'assign_ict_by_load', notify: false };
  }

  if (needsTemplateChange) {
    return { kind: 'update', ticketId, reason: 'template_enforce', notify: false };
  }

  return { kind: 'skip', ticketId, reason: 'already_assigned_or_not_actionable' };
}

async function runScanOnce(config: DispatcherConfig): Promise<ScanRunResult> {
  const stats: ScanStats = { scanned: 0, matched: 0, assigned: 0, notified: 0, skipped: 0, errors: 0 };

  const contacts = listTechnicianContacts();
  let leaveStatusByIctName: LeaveStatusByIctName | null = null;
  if (config.leaveScheduleEnabled) {
    try {
      const dateIso = getTodayIsoDateForOffsetHours(config.leaveScheduleTzOffsetHours);
      const scheduleIndex = buildLeaveScheduleIndexForDate({
        xlsxPath: config.leaveScheduleXlsxPath,
        sheetName: config.leaveScheduleSheetName,
        dateIsoYyyyMmDd: dateIso,
        dateHeaderRow1Based: 9,
        dataStartRow1Based: 10,
        dateShiftDays: config.leaveScheduleDateShiftDays,
      });

      const byIct: LeaveStatusByIctName = new Map<string, LeaveStatus>();
      for (const c of contacts) {
        const nameForSchedule = c.leave_schedule_name ?? c.ict_name ?? c.name;
        const match = resolveLeaveScheduleEntry({
          scheduleIndex,
          personName: nameForSchedule,
          allowFuzzy: config.leaveScheduleAllowFuzzy,
          similarityThreshold: config.leaveScheduleSimilarityThreshold,
        });
        if (!match) {
          byIct.set(c.ict_name, { found: false, onsite: false, status: null, matchedKey: null });
        } else {
          byIct.set(c.ict_name, {
            found: true,
            onsite: match.entry.onsite,
            status: match.entry.status,
            matchedKey: match.matchedKey,
          });
        }
      }
      leaveStatusByIctName = byIct;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Leave schedule load failed, continuing without filtering: ${message}`);
      leaveStatusByIctName = null;
    }
  }
  const days = Math.max(1, Math.ceil(config.maxAgeHours / 24));
  const ids = await getAllRequests(days);
  const limitedIds = ids.slice(0, config.maxTicketsPerRun);

  const requests: ServiceDeskRequest[] = [];
  const loadByGroupIct = new Map<string, Map<string, number>>();
  for (const id of limitedIds) {
    stats.scanned += 1;
    const requestObj = await viewRequest(id);
    if (!requestObj) {
      stats.errors += 1;
      continue;
    }
    requests.push(requestObj);

    if (isClosedStatus(config, requestObj)) continue;
    const ict = normalizeText(requestObj.udf_fields?.udf_pick_601);
    if (!ict) continue;

    let groupName = normalizeText(requestObj.technician?.name) || normalizeText(requestObj.group?.name);
    if (!groupName) {
      const contact = getContactByIctTechnicianName(ict);
      groupName = normalizeText(contact?.technician);
    }
    if (!groupName) continue;

    const gk = groupKey(groupName);
    const currentGroup = loadByGroupIct.get(gk) ?? new Map<string, number>();
    const current = currentGroup.get(ict) ?? 0;
    currentGroup.set(ict, current + 1);
    loadByGroupIct.set(gk, currentGroup);
  }

  let assignmentsLeft = config.maxAssignmentsPerRun;
  let notificationsLeft = config.notifyMaxPerRun;
  let remindersLeft = config.reminderMaxPerRun;

  const digestItems: Array<{ ticketId: string; groupName: string; subject: string }> = [];
  const assignmentLogs: AssignmentLogItem[] = [];
  const reminderLogs: ReminderLogItem[] = [];

  const shouldUseTicketState = !(config.dryRun && config.dryRunIgnoreRedisState);

  for (const requestObj of requests) {
    if (isClosedStatus(config, requestObj)) {
      stats.skipped += 1;
      continue;
    }

    if (!shouldConsiderByAge(config, requestObj)) {
      stats.skipped += 1;
      continue;
    }

    const ticketId = requestObj.id;
    const existingGroup = normalizeText(requestObj.technician?.name);
    const existingSdpGroup = normalizeText(requestObj.group?.name);
    const existingIct = normalizeText(requestObj.udf_fields?.udf_pick_601);
    const ageHours = getTicketAgeHours(requestObj);
    if (ageHours === null) {
      stats.skipped += 1;
      continue;
    }

    const state = shouldUseTicketState ? await loadTicketState(ticketId) : null;

    if (config.reminderMode !== 'none' && remindersLeft > 0) {
      const isGroupMissing = existingGroup.length === 0 && existingSdpGroup.length === 0;
      const isIctMissing = existingIct.length === 0 || existingIct.toLowerCase() === 'ict helpdesk';

      let reminderKind: ReminderLogItem['kind'] | null = null;
      let reminderTarget = '';
      let reminderPhones: string[] = [];
      let reminderReason = '';

      if (isGroupMissing && config.remindUnassignedAfterHours > 0 && ageHours >= config.remindUnassignedAfterHours) {
        reminderKind = 'unassigned';
        reminderTarget = config.groupNames.triage;
        reminderPhones = resolveContactsForGroup({ targetGroupName: reminderTarget, contacts }).map((c) => c.phone);
        reminderReason = `unassigned>${config.remindUnassignedAfterHours}h`;
      } else if (!isGroupMissing && isIctMissing && config.remindUnpickedIctAfterHours > 0 && ageHours >= config.remindUnpickedIctAfterHours) {
        reminderKind = 'unpicked_ict';
        reminderTarget = existingGroup || existingSdpGroup;
        reminderPhones = resolveContactsForGroup({ targetGroupName: reminderTarget, contacts }).map((c) => c.phone);
        reminderReason = `unpicked_ict>${config.remindUnpickedIctAfterHours}h`;
      } else if (!isGroupMissing && !isIctMissing && config.remindAssignedOpenAfterHours > 0 && ageHours >= config.remindAssignedOpenAfterHours) {
        reminderKind = 'assigned_open';
        reminderTarget = existingIct;
        const ictContact = getContactByIctTechnicianName(existingIct);
        if (ictContact?.phone) {
          reminderPhones = [ictContact.phone];
        } else {
          reminderPhones = resolveContactsForGroup({ targetGroupName: existingGroup || existingSdpGroup, contacts }).map((c) => c.phone);
        }
        reminderReason = `assigned_open>${config.remindAssignedOpenAfterHours}h`;
      }

      if (reminderKind && reminderPhones.length > 0) {
        const reminderHash = computeNotificationHash(`reminder|${reminderKind}|${ticketId}|${reminderTarget}|${reminderReason}`);
        const sinceReminderHours = hoursSinceIso(state?.lastReminderAtIso);
        const inCooldown =
          typeof sinceReminderHours === 'number' &&
          Number.isFinite(sinceReminderHours) &&
          sinceReminderHours < config.reminderCooldownHours;

        if (!inCooldown && state?.lastReminderHash !== reminderHash) {
          if (reminderLogs.length < config.logActionsMax) {
            reminderLogs.push({
              ticketId,
              kind: reminderKind,
              target: reminderTarget,
              link: buildTicketLink(ticketId),
              reason: reminderReason,
            });
          }

          if (!config.dryRun && config.reminderMode === 'direct') {
            const msg = buildReminderMessage({
              ticketId,
              kind: reminderKind,
              subject: normalizeText(requestObj.subject),
              status: normalizeText(requestObj.status?.name),
              groupName: existingGroup,
              ictTechnician: existingIct,
              ageHours,
              reason: reminderReason,
            });
            const res = await sendDirectNotifications({ config, phones: reminderPhones, message: msg });
            if (res.sent > 0) {
              remindersLeft -= 1;
              if (shouldUseTicketState) {
                await saveTicketState({
                  ticketId,
                  lastActionAtIso: state?.lastActionAtIso,
                  lastAssignedGroupName: state?.lastAssignedGroupName ?? null,
                  lastAssignedIctTechnician: state?.lastAssignedIctTechnician ?? null,
                  lastNotifiedHash: state?.lastNotifiedHash ?? null,
                  lastReminderAtIso: new Date().toISOString(),
                  lastReminderHash: reminderHash,
                });
              }
            }
          }
        }
      }
    }

    const action = await planAction({ config, requestObj, contacts, loadByGroupIct, leaveStatusByIctName });
    if (action.kind === 'skip') {
      stats.skipped += 1;
      continue;
    }

    stats.matched += 1;

    if (action.kind === 'update') {
      if (assignmentsLeft <= 0) {
        stats.skipped += 1;
        continue;
      }

      const existingTemplate = normalizeText(requestObj.template?.name);
      const shouldEnforceTemplate =
        config.enforceTemplate &&
        config.requiredTemplateId.trim().length > 0 &&
        config.requiredTemplateName.trim().length > 0;
      const hasTemplateChange =
        shouldEnforceTemplate &&
        (existingTemplate.length === 0 || existingTemplate.toLowerCase() !== config.requiredTemplateName.trim().toLowerCase());

      const ignoreLastAssigned = !shouldUseTicketState;
      const hasGroupChange =
        typeof action.targetGroupName === 'string' &&
        action.targetGroupName.trim().length > 0 &&
        existingGroup.toLowerCase() !== action.targetGroupName.toLowerCase() &&
        (existingGroup.length === 0 ||
          ignoreLastAssigned ||
          !state?.lastAssignedGroupName ||
          state.lastAssignedGroupName.toLowerCase() !== action.targetGroupName.toLowerCase());

      const hasIctChange =
        typeof action.targetIctTechnician === 'string' &&
        action.targetIctTechnician.trim().length > 0 &&
        existingIct.toLowerCase() !== action.targetIctTechnician.toLowerCase() &&
        (existingIct.length === 0 ||
          ignoreLastAssigned ||
          !state?.lastAssignedIctTechnician ||
          state.lastAssignedIctTechnician.toLowerCase() !== action.targetIctTechnician.toLowerCase());

      const hasAssignmentChange = hasGroupChange || hasIctChange;
      if (!hasAssignmentChange && !hasTemplateChange) {
        stats.skipped += 1;
        continue;
      }

      if (shouldUseTicketState) {
        const sinceLastActionHours = hoursSinceIso(state?.lastActionAtIso);
        const inManualBackoff =
          config.manualOverrideBackoffHours > 0 &&
          typeof sinceLastActionHours === 'number' &&
          Number.isFinite(sinceLastActionHours) &&
          sinceLastActionHours < config.manualOverrideBackoffHours;
        const groupManualOverride =
          !!state?.lastAssignedGroupName &&
          !!existingGroup &&
          existingGroup.toLowerCase() !== state.lastAssignedGroupName.toLowerCase();
        const ictManualOverride =
          !!state?.lastAssignedIctTechnician &&
          !!existingIct &&
          existingIct.toLowerCase() !== state.lastAssignedIctTechnician.toLowerCase();
        if (inManualBackoff && ((groupManualOverride && hasGroupChange) || (ictManualOverride && hasIctChange))) {
          stats.skipped += 1;
          continue;
        }
      }

      const toGroup = hasGroupChange ? normalizeText(action.targetGroupName) : existingGroup;
      const toIct = hasIctChange ? normalizeText(action.targetIctTechnician) : existingIct;
      const toIctLoad = (() => {
        if (!toIct || !toGroup) return 0;
        const m = loadByGroupIct.get(groupKey(toGroup));
        return m ? (m.get(toIct) ?? 0) : 0;
      })();
      const reason = hasTemplateChange ? `${action.reason}|template_enforce` : action.reason;

      let applied = false;
      let applyError: string | null = null;
      let verified = false;
      let afterTemplate = existingTemplate;
      let afterGroup = existingGroup;
      let afterIctTechnician = existingIct;

      if (config.dryRun) {
        applied = false;
        verified = false;
      } else {
        if (hasTemplateChange) {
          const templateRes = await updateRequest(action.ticketId, {
            templateId: config.requiredTemplateId,
            templateName: config.requiredTemplateName,
            isServiceTemplate: config.requiredTemplateIsService,
            serviceCategory: normalizeText(requestObj.service_category?.name) || undefined,
          });
          if (!templateRes.success) {
            stats.errors += 1;
            applyError = `template_update_failed:${templateRes.message}`;
          }
        }

        if (!applyError && hasAssignmentChange) {
          const updateRes = await updateRequest(action.ticketId, {
            technicianName: hasGroupChange ? action.targetGroupName : undefined,
            ictTechnician: hasIctChange ? action.targetIctTechnician : undefined,
          });
          if (!updateRes.success) {
            stats.errors += 1;
            applyError = `assignment_update_failed:${updateRes.message}`;
          }
        }

        applied = !applyError;

        if (applied) {
          const refreshed = await viewRequest(action.ticketId);
          if (!refreshed) {
            stats.errors += 1;
            applyError = 'verify_failed:view_request_null';
          } else {
            afterTemplate = normalizeText(refreshed.template?.name);
            afterGroup = normalizeText(refreshed.technician?.name);
            afterIctTechnician = normalizeText(refreshed.udf_fields?.udf_pick_601);

            const templateOk =
              !hasTemplateChange || afterTemplate.toLowerCase() === config.requiredTemplateName.trim().toLowerCase();
            const groupOk = !hasGroupChange || afterGroup.toLowerCase() === toGroup.toLowerCase();
            const ictOk = !hasIctChange || afterIctTechnician.toLowerCase() === toIct.toLowerCase();

            verified = templateOk && groupOk && ictOk;
            if (!verified) {
              stats.errors += 1;
              applyError = `verify_failed:template=${afterTemplate}|group=${afterGroup}|ict=${afterIctTechnician}`;
            }
          }
        }
      }

      if (assignmentLogs.length < config.logActionsMax) {
        assignmentLogs.push({
          ticketId: action.ticketId,
          link: buildTicketLink(action.ticketId),
          reason,
          fromTemplate: existingTemplate,
          toTemplate: hasTemplateChange ? config.requiredTemplateName : existingTemplate,
          fromGroup: existingGroup,
          toGroup,
          fromIctTechnician: existingIct,
          toIctTechnician: toIct,
          toIctLoad,
          applied,
          applyError,
          verified,
          afterTemplate,
          afterGroup,
          afterIctTechnician,
        });
      }

      if (!config.dryRun && (!applied || !verified)) {
        continue;
      }

      assignmentsLeft -= 1;
      stats.assigned += 1;

      if (hasAssignmentChange && shouldUseTicketState) {
        await saveTicketState({
          ticketId: action.ticketId,
          lastActionAtIso: new Date().toISOString(),
          lastAssignedGroupName: config.dryRun
            ? (state?.lastAssignedGroupName ?? null)
            : hasGroupChange
              ? action.targetGroupName ?? null
              : state?.lastAssignedGroupName ?? null,
          lastAssignedIctTechnician: config.dryRun
            ? (state?.lastAssignedIctTechnician ?? null)
            : hasIctChange
              ? action.targetIctTechnician ?? null
              : state?.lastAssignedIctTechnician ?? null,
          lastNotifiedHash: state?.lastNotifiedHash ?? null,
          lastReminderAtIso: state?.lastReminderAtIso ?? null,
          lastReminderHash: state?.lastReminderHash ?? null,
        });
      }

      if (config.notifyMode === 'digest') {
        if (hasAssignmentChange) {
          digestItems.push({
            ticketId: action.ticketId,
            groupName: action.targetGroupName ?? existingGroup,
            subject: normalizeText(requestObj.subject),
          });
        }
        continue;
      }

      if (!hasAssignmentChange) continue;
      if (!action.notify || config.notifyMode !== 'direct') continue;
      if (notificationsLeft <= 0) continue;

      const notifyGroupName = action.targetGroupName ?? existingGroup;
      const groupContacts = resolveContactsForGroup({ targetGroupName: notifyGroupName, contacts });
      if (groupContacts.length === 0) continue;

      const requester = normalizeText(requestObj.requester?.name) || normalizeText(requestObj.requester?.email_id);
      const createdAt = normalizeText(requestObj.created_time?.display_value);
      const status = normalizeText(requestObj.status?.name);
      const priority = normalizeText(requestObj.priority?.name);
      const subject = normalizeText(requestObj.subject);

      const notificationHash = computeNotificationHash(
        `update|${action.ticketId}|${action.targetGroupName ?? ''}|${action.targetIctTechnician ?? ''}|${reason}`
      );
      if (shouldUseTicketState && state?.lastNotifiedHash === notificationHash) continue;

      const msg = buildNotificationMessage({
        ticketId: action.ticketId,
        subject,
        status,
        priority,
        groupName: notifyGroupName,
        requester,
        createdAt,
        reason,
      });

      if (!config.dryRun) {
        const phones = groupContacts.map((c) => c.phone);
        const res = await sendDirectNotifications({ config, phones, message: msg });
        if (res.sent > 0) {
          stats.notified += 1;
          notificationsLeft -= 1;
          if (shouldUseTicketState) {
            await saveTicketState({
              ticketId: action.ticketId,
              lastActionAtIso: new Date().toISOString(),
              lastAssignedGroupName: hasGroupChange ? action.targetGroupName ?? null : state?.lastAssignedGroupName ?? null,
              lastAssignedIctTechnician: hasIctChange ? action.targetIctTechnician ?? null : state?.lastAssignedIctTechnician ?? null,
              lastNotifiedHash: notificationHash,
              lastReminderAtIso: state?.lastReminderAtIso ?? null,
              lastReminderHash: state?.lastReminderHash ?? null,
            });
          }
        }
      }
      continue;
    }

    if (action.kind === 'notify_group') {
      if (config.notifyMode !== 'direct') continue;
      if (notificationsLeft <= 0) continue;

      const groupContacts = resolveContactsForGroup({ targetGroupName: action.targetGroupName, contacts });
      if (groupContacts.length === 0) continue;

      const requester = normalizeText(requestObj.requester?.name) || normalizeText(requestObj.requester?.email_id);
      const createdAt = normalizeText(requestObj.created_time?.display_value);
      const status = normalizeText(requestObj.status?.name);
      const priority = normalizeText(requestObj.priority?.name);
      const subject = normalizeText(requestObj.subject);

      const notificationHash = computeNotificationHash(`notify_group|${action.ticketId}|${action.targetGroupName}|${action.reason}`);
      if (shouldUseTicketState && state?.lastNotifiedHash === notificationHash) continue;

      const msg = buildNotificationMessage({
        ticketId: action.ticketId,
        subject,
        status,
        priority,
        groupName: action.targetGroupName,
        requester,
        createdAt,
        reason: action.reason,
      });

      if (!config.dryRun) {
        const phones = groupContacts.map((c) => c.phone);
        const res = await sendDirectNotifications({ config, phones, message: msg });
        if (res.sent > 0) {
          stats.notified += 1;
          notificationsLeft -= 1;
          if (shouldUseTicketState) {
            await saveTicketState({
              ticketId: action.ticketId,
              lastActionAtIso: new Date().toISOString(),
              lastAssignedGroupName: state?.lastAssignedGroupName ?? null,
              lastAssignedIctTechnician: state?.lastAssignedIctTechnician ?? null,
              lastNotifiedHash: notificationHash,
              lastReminderAtIso: state?.lastReminderAtIso ?? null,
              lastReminderHash: state?.lastReminderHash ?? null,
            });
          }
        }
      }
      continue;
    }
  }

  if (config.notifyMode === 'digest' && config.digestNumbers.length > 0 && digestItems.length > 0) {
    const lines: string[] = [];
    lines.push('*Dispatcher Digest (Unassigned Routing)*');
    lines.push(`Total: ${digestItems.length}`);
    lines.push('');
    const maxList = Math.min(digestItems.length, 20);
    for (let i = 0; i < maxList; i += 1) {
      const it = digestItems[i];
      const subject = it.subject ? it.subject : '-';
      lines.push(`${i + 1}. ${it.ticketId} | ${it.groupName} | ${subject}`);
    }
    if (digestItems.length > maxList) {
      lines.push('');
      lines.push(`(+${digestItems.length - maxList} more)`);
    }
    const message = lines.join('\n');
    if (!config.dryRun) {
      await sendDirectNotifications({ config, phones: config.digestNumbers, message });
      stats.notified += 1;
    }
  }

  let digestPreview: string | null = null;
  const zoned = getZonedDateKeyAndHour(config.digestTimeZone, new Date());
  if (zoned && config.digestScheduleHours.includes(zoned.hour) && config.digestNumbers.length > 0) {
    digestPreview = buildOperationalDigestMessage({ config, requests });
    if (!config.dryRun) {
      const key = digestSentKey(zoned.dateKey, zoned.hour);
      const shouldSend = await tryMarkDigestSent(key);
      if (shouldSend) {
        await sendDirectNotifications({ config, phones: config.digestNumbers, message: digestPreview });
      }
    }
  }

  return { stats, assignments: assignmentLogs, reminders: reminderLogs, digestPreview };
}

export function startHelpdeskDispatcher(): { stop: () => void } {
  const config = buildConfig();
  if (!config.enabled) {
    console.log('Helpdesk dispatcher disabled (DISPATCHER_ENABLED=false).');
    return { stop: () => undefined };
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let runCount = 0;

  const tick = async () => {
    if (stopped) return;
    const lockToken = await acquireScanLock(config.lockTtlSeconds);
    if (!lockToken) return;
    try {
      runCount += 1;
      const result = await runScanOnce(config);
      console.log(
        JSON.stringify(
          {
            scope: 'helpdesk_dispatcher',
            runCount,
            mode: config.dryRun ? 'dry_run' : 'live',
            notifyMode: config.notifyMode,
            reminderMode: config.reminderMode,
            aiRoutingEnabled: config.aiRoutingEnabled,
            aiKeyPresent: Boolean(getOptionalEnv('OPENAI_API_KEY')),
            enforceTemplate: config.enforceTemplate,
            requiredTemplateName: config.requiredTemplateName,
            requiredTemplateId: config.requiredTemplateId,
            dryRunIgnoreRedisState: config.dryRunIgnoreRedisState,
            minAgeHours: config.minAgeHours,
            maxAgeHours: config.maxAgeHours,
            maxTicketsPerRun: config.maxTicketsPerRun,
            maxAssignmentsPerRun: config.maxAssignmentsPerRun,
            notifyMaxPerRun: config.notifyMaxPerRun,
            stats: result.stats,
            assignments: config.logActions ? result.assignments : undefined,
            reminders: config.logActions ? result.reminders : undefined,
            digestPreview: config.logActions ? result.digestPreview : undefined,
          },
          null,
          2
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Dispatcher scan error: ${message}`);
    } finally {
      await releaseScanLock(lockToken);
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    const now = new Date();
    const nextRunAt = new Date(now.getTime() + config.scanIntervalSeconds * 1000);
    console.log(
      JSON.stringify(
        {
          scope: 'helpdesk_dispatcher_heartbeat',
          runCount,
          scanIntervalSeconds: config.scanIntervalSeconds,
          nowIso: now.toISOString(),
          nextRunAtIso: nextRunAt.toISOString(),
        },
        null,
        2
      )
    );
    timer = setTimeout(() => {
      void tick().finally(() => scheduleNext());
    }, config.scanIntervalSeconds * 1000);
  };

  void tick().finally(() => {
    if (config.runOnce) {
      stopped = true;
      return;
    }
    scheduleNext();
  });

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
