import type { MessagingService } from '../channel/messagingService.js'
import { loadPreviousTicketState, saveTicketState } from '../tickets/ticketStateStore.js'
import {
  getContactByIctTechnicianName,
  listTechnicianContacts,
  type TechnicianContact,
} from '../integrations/technicianContacts.js'
import {
  buildTicketLink,
  getAllRequests,
  type ServiceDeskRequest,
  updateRequest,
  viewRequest,
} from '../integrations/serviceDesk.js'
import { phoneNumberFormatter } from '../../utils/phone.js'
import {
  buildLeaveScheduleIndexForDate,
  getTodayIsoDateForOffsetHours,
  resolveLeaveScheduleEntry,
} from '../../leaveScheduleCheck.js'
import crypto from 'node:crypto'
import OpenAI from 'openai'

type NotifyMode = 'none' | 'direct' | 'digest'
type ReminderMode = 'none' | 'direct'

type DispatcherConfig = {
  enabled: boolean
  runOnce: boolean
  dryRun: boolean
  scanIntervalSeconds: number
  minAgeHours: number
  maxAgeHours: number
  maxTicketsPerRun: number
  notifyMode: NotifyMode
  notifyMaxPerRun: number
  maxAssignmentsPerRun: number
  reminderMode: ReminderMode
  reminderMaxPerRun: number
  reminderCooldownHours: number
  remindUnassignedAfterHours: number
  remindUnpickedIctAfterHours: number
  remindAssignedOpenAfterHours: number
  manualOverrideBackoffHours: number
  dryRunIgnoreRedisState: boolean
  digestNumbers: string[]
  digestMaxItems: number
  groupNames: {
    triage: string
    docControl: string
    itSupport: string
    itField: string
  }
  closedStatuses: string[]
  aiRoutingEnabled: boolean
  aiRoutingConfidenceThreshold: number
  aiRoutingModel: string
  leaveScheduleEnabled: boolean
  leaveScheduleXlsxPath: string
  leaveScheduleSheetName: string
  leaveScheduleTzOffsetHours: number
  leaveScheduleDateShiftDays: number
  leaveScheduleAllowFuzzy: boolean
  leaveScheduleSimilarityThreshold: number
}

type DispatcherStats = {
  scanned: number
  matched: number
  assigned: number
  notified: number
  skipped: number
  errors: number
}

type DispatcherCandidate = {
  ticketId: string
  groupName: string
  subject: string
  requester: string
  status: string
  priority: string
  createdAt: string
  ageHours: number
  hasTechnician: boolean
  hasIctTechnician: boolean
  reason: string
  targetGroupName?: string
  targetIctTechnician?: string
}

type LeaveStatus = {
  found: boolean
  onsite: boolean
  status: string | null
  matchedKey: string | null
}

type LeaveStatusByIctName = Map<string, LeaveStatus>

type RouteDecision = {
  routeKey: 'doc_control' | 'it_support' | 'it_field' | 'triage'
  targetGroupName: string
  reason: string
}

type AiRouteDecision = {
  routeKey: RouteDecision['routeKey']
  confidence: number
  reason: string
}

type PlannedAction =
  | {
      kind: 'update'
      ticketId: string
      targetGroupName?: string
      targetIctTechnician?: string
      reason: string
      notify: boolean
    }
  | { kind: 'skip'; ticketId: string; reason: string }

function getOptionalEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim()
  return raw ? raw : undefined
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = getOptionalEnv(name)
  if (!raw) return defaultValue
  const value = raw.toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  return defaultValue
}

function parseNumberEnv(name: string, defaultValue: number): number {
  const raw = getOptionalEnv(name)
  if (!raw) return defaultValue
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : defaultValue
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function parseNotifyMode(raw: string | undefined): NotifyMode {
  if (!raw) return 'none'
  const value = raw.trim().toLowerCase()
  if (value === 'direct' || value === 'digest' || value === 'none') return value
  return 'none'
}

function parseReminderMode(raw: string | undefined): ReminderMode {
  if (!raw) return 'none'
  const value = raw.trim().toLowerCase()
  if (value === 'direct' || value === 'none') return value
  return 'none'
}

function buildConfig(): DispatcherConfig {
  const dataDir = process.env.DATA_DIR?.trim() ? process.env.DATA_DIR.trim() : `${process.cwd()}/data`
  return {
    enabled: parseBooleanEnv('DISPATCHER_ENABLED', false),
    runOnce: parseBooleanEnv('DISPATCHER_RUN_ONCE', false),
    dryRun: parseBooleanEnv('DISPATCHER_DRY_RUN', true),
    scanIntervalSeconds: Math.max(10, Math.floor(parseNumberEnv('DISPATCHER_SCAN_INTERVAL_SECONDS', 300))),
    minAgeHours: Math.max(0, parseNumberEnv('DISPATCHER_MIN_AGE_HOURS', 0)),
    maxAgeHours: Math.max(1, parseNumberEnv('DISPATCHER_MAX_AGE_HOURS', 24)),
    maxTicketsPerRun: Math.max(1, Math.floor(parseNumberEnv('DISPATCHER_MAX_TICKETS_PER_RUN', 30))),
    notifyMode: parseNotifyMode(getOptionalEnv('DISPATCHER_NOTIFY_MODE')),
    notifyMaxPerRun: Math.max(0, Math.floor(parseNumberEnv('DISPATCHER_NOTIFY_MAX_PER_RUN', 5))),
    maxAssignmentsPerRun: Math.max(0, Math.floor(parseNumberEnv('DISPATCHER_MAX_ASSIGNMENTS_PER_RUN', 10))),
    reminderMode: parseReminderMode(getOptionalEnv('DISPATCHER_REMINDER_MODE')),
    reminderMaxPerRun: Math.max(0, Math.floor(parseNumberEnv('DISPATCHER_REMINDER_MAX_PER_RUN', 5))),
    reminderCooldownHours: Math.max(0, parseNumberEnv('DISPATCHER_REMINDER_COOLDOWN_HOURS', 6)),
    remindUnassignedAfterHours: Math.max(0, parseNumberEnv('DISPATCHER_REMIND_UNASSIGNED_AFTER_HOURS', 2)),
    remindUnpickedIctAfterHours: Math.max(0, parseNumberEnv('DISPATCHER_REMIND_UNPICKED_ICT_AFTER_HOURS', 2)),
    remindAssignedOpenAfterHours: Math.max(0, parseNumberEnv('DISPATCHER_REMIND_ASSIGNED_OPEN_AFTER_HOURS', 8)),
    manualOverrideBackoffHours: Math.max(0, parseNumberEnv('DISPATCHER_MANUAL_OVERRIDE_BACKOFF_HOURS', 12)),
    dryRunIgnoreRedisState: parseBooleanEnv('DISPATCHER_DRY_RUN_IGNORE_REDIS_STATE', false),
    digestNumbers: parseCsv(getOptionalEnv('DISPATCHER_DIGEST_NUMBERS')),
    digestMaxItems: Math.max(1, Math.floor(parseNumberEnv('DISPATCHER_DIGEST_MAX_ITEMS', 20))),
    groupNames: {
      triage: getOptionalEnv('DISPATCHER_GROUP_TRIAGE') ?? 'IT Support',
      docControl: getOptionalEnv('DISPATCHER_GROUP_DOC_CONTROL') ?? 'Document Control',
      itSupport: getOptionalEnv('DISPATCHER_GROUP_IT_SUPPORT') ?? 'IT Support',
      itField: getOptionalEnv('DISPATCHER_GROUP_IT_FIELD') ?? 'IT Field Support',
    },
    closedStatuses: (parseCsv(getOptionalEnv('DISPATCHER_CLOSED_STATUSES') ?? 'Resolved,Closed') || ['Resolved', 'Closed']).map(
      (value) => value.toLowerCase()
    ),
    aiRoutingEnabled: parseBooleanEnv('DISPATCHER_AI_ROUTING_ENABLED', true),
    aiRoutingConfidenceThreshold: Math.min(1, Math.max(0, parseNumberEnv('DISPATCHER_AI_CONFIDENCE_THRESHOLD', 0.8))),
    aiRoutingModel: getOptionalEnv('DISPATCHER_AI_MODEL') ?? 'gpt-4o-mini',
    leaveScheduleEnabled: parseBooleanEnv('DISPATCHER_LEAVE_SCHEDULE_ENABLED', false),
    leaveScheduleXlsxPath:
      getOptionalEnv('DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH') ?? `${dataDir}/leave/leave-schedule.xlsx`,
    leaveScheduleSheetName: getOptionalEnv('DISPATCHER_LEAVE_SCHEDULE_SHEET') ?? 'Human Resource',
    leaveScheduleTzOffsetHours: Math.floor(parseNumberEnv('DISPATCHER_LEAVE_SCHEDULE_TZ_OFFSET_HOURS', 8)),
    leaveScheduleDateShiftDays: Math.floor(parseNumberEnv('DISPATCHER_LEAVE_SCHEDULE_DATE_SHIFT_DAYS', 1)),
    leaveScheduleAllowFuzzy: parseBooleanEnv('DISPATCHER_LEAVE_SCHEDULE_FUZZY', true),
    leaveScheduleSimilarityThreshold: Math.min(1, Math.max(0, parseNumberEnv('DISPATCHER_LEAVE_SCHEDULE_SIM_THRESHOLD', 0.9))),
  }
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeRoutingText(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `
}

function hasRoutingKeyword(text: string, keyword: string): boolean {
  const normalizedKeyword = normalizeRoutingText(keyword)
  return text.includes(normalizedKeyword)
}

function getTicketAgeHours(request: ServiceDeskRequest): number | null {
  const createdAt = request.created_time?.display_value
  if (!createdAt) return null
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return null
  return (Date.now() - date.getTime()) / (1000 * 60 * 60)
}

function isClosedStatus(config: DispatcherConfig, request: ServiceDeskRequest): boolean {
  const status = normalizeText(request.status?.name).toLowerCase()
  if (!status) return false
  return config.closedStatuses.some((item) => status === item || status.startsWith(`${item} `) || status.startsWith(`${item}-`))
}

function resolveContactsForGroup(groupName: string, contacts: TechnicianContact[]): TechnicianContact[] {
  const target = groupName.trim().toLowerCase()
  if (!target) return []
  return contacts.filter((contact) => contact.technician.trim().toLowerCase().includes(target))
}

function groupKey(groupName: string): string {
  return groupName.trim().toLowerCase()
}

function hashToUint32(input: string): number {
  const buf = crypto.createHash('sha256').update(input).digest()
  return buf.readUInt32BE(0)
}

function pickIctTechnicianByLoad(args: {
  config: DispatcherConfig
  ticketId: string
  groupName: string
  contacts: TechnicianContact[]
  loadByGroupIct: Map<string, Map<string, number>>
  leaveStatusByIctName: LeaveStatusByIctName | null
}): TechnicianContact | null {
  const groupContacts = resolveContactsForGroup(args.groupName, args.contacts)
  if (groupContacts.length === 0) return null

  const loadByIctTechnician = args.loadByGroupIct.get(groupKey(args.groupName)) ?? new Map<string, number>()
  let best: TechnicianContact | null = null
  let bestScore = Number.POSITIVE_INFINITY
  let bestTie = Number.POSITIVE_INFINITY

  for (const contact of groupContacts) {
    if (args.leaveStatusByIctName) {
      const leave = args.leaveStatusByIctName.get(contact.ict_name)
      if (!leave || !leave.found || !leave.onsite) continue
    }

    const load = loadByIctTechnician.get(contact.ict_name) ?? 0
    const score = load
    const tie = hashToUint32(`${args.ticketId}|${contact.ict_name}`) / 2 ** 32

    if (score < bestScore) {
      best = contact
      bestScore = score
      bestTie = tie
      continue
    }

    if (score === bestScore && tie < bestTie) {
      best = contact
      bestTie = tie
    }
  }

  return best
}

function mapRouteKeyToGroup(config: DispatcherConfig, routeKey: RouteDecision['routeKey']): string {
  if (routeKey === 'doc_control') return config.groupNames.docControl
  if (routeKey === 'it_field') return config.groupNames.itField
  if (routeKey === 'it_support') return config.groupNames.itSupport
  return config.groupNames.triage
}

function routeTicketHeuristic(config: DispatcherConfig, requestObj: ServiceDeskRequest): RouteDecision {
  const subject = normalizeText(requestObj.subject)
  const desc = normalizeText(requestObj.description)
  const category = normalizeText(requestObj.service_category?.name)
  const combined = normalizeRoutingText(`${subject}\n${desc}\n${category}`)
  const hasAny = (needles: string[]) => needles.some((item) => hasRoutingKeyword(combined, item))

  if (hasAny(['srf', 'service request form', 'approval', 'document control', 'document', 'scan', 'archive', 'sop', 'procedure'])) {
    return { routeKey: 'doc_control', targetGroupName: config.groupNames.docControl, reason: 'keyword_match:doc_control' }
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
      'internet',
    ])
  ) {
    return { routeKey: 'it_field', targetGroupName: config.groupNames.itField, reason: 'keyword_match:it_field' }
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
      'pdf',
      'file',
    ])
  ) {
    return { routeKey: 'it_support', targetGroupName: config.groupNames.itSupport, reason: 'keyword_match:it_support' }
  }

  return { routeKey: 'triage', targetGroupName: config.groupNames.triage, reason: 'default:triage' }
}

function getOpenAiClient(): OpenAI {
  const apiKey = getOptionalEnv('OPENAI_API_KEY')
  if (!apiKey) throw new Error('OPENAI_API_KEY must be set')
  return new OpenAI({ apiKey })
}

function safeParseAiRouteDecision(raw: string): AiRouteDecision | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const tryParse = (input: string): unknown => JSON.parse(input)
  let parsed: unknown

  try {
    parsed = tryParse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return null
    try {
      parsed = tryParse(trimmed.slice(start, end + 1))
    } catch {
      return null
    }
  }

  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const routeKey = record.routeKey
  const confidence = record.confidence
  const reason = record.reason

  const isRouteKey =
    routeKey === 'doc_control' || routeKey === 'it_support' || routeKey === 'it_field' || routeKey === 'triage'
  if (!isRouteKey) return null
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null
  if (typeof reason !== 'string') return null

  return { routeKey, confidence, reason }
}

async function routeTicket(config: DispatcherConfig, requestObj: ServiceDeskRequest): Promise<RouteDecision> {
  const heuristicWithFallback = (fallback: string): RouteDecision => {
    const routed = routeTicketHeuristic(config, requestObj)
    return { ...routed, reason: `ai_fallback:${fallback}|${routed.reason}` }
  }

  if (!config.aiRoutingEnabled) return routeTicketHeuristic(config, requestObj)
  if (!getOptionalEnv('OPENAI_API_KEY')) return heuristicWithFallback('missing_key')

  const subject = normalizeText(requestObj.subject)
  const desc = normalizeText(requestObj.description)
  const category = normalizeText(requestObj.service_category?.name)
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
    '- it_support: PC/Laptop problems, Windows, peripherals, Office apps, printer/scanner, internal apps, file server, system & mail.',
    '- it_field: network/WiFi/LAN/cabling/switch/router/VPN/IP, CCTV/camera/NVR, Radio HT, deskphone/PABX, television/TV, access card/RFID, and field/on-site/network work.',
    '- doc_control: administration, document register, document control, scanning/archiving, SOP/procedure, simcard request, and related document operations.',
    '- triage: only if subject/description is too vague to decide confidently.',
    '',
    `Subject: ${subject}`,
    `Category: ${category}`,
    `Description: ${desc}`,
  ].join('\n')

  try {
    const openai = getOpenAiClient()
    const chatCompletion = await openai.chat.completions.create({
      model: config.aiRoutingModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 120,
    })
    const content = chatCompletion.choices[0]?.message?.content ?? ''
    const ai = safeParseAiRouteDecision(content)
    if (!ai) return heuristicWithFallback('parse_fail')
    if (ai.confidence < config.aiRoutingConfidenceThreshold) {
      const conf = Math.round(ai.confidence * 1000) / 1000
      const threshold = Math.round(config.aiRoutingConfidenceThreshold * 1000) / 1000
      return {
        routeKey: 'triage',
        targetGroupName: mapRouteKeyToGroup(config, 'triage'),
        reason: `ai_low_conf(conf=${conf},th=${threshold})|triage`,
      }
    }
    return {
      routeKey: ai.routeKey,
      targetGroupName: mapRouteKeyToGroup(config, ai.routeKey),
      reason: `ai:${ai.reason}`,
    }
  } catch {
    return heuristicWithFallback('exception')
  }
}

function buildCandidate(config: DispatcherConfig, request: ServiceDeskRequest): DispatcherCandidate | null {
  const ageHours = getTicketAgeHours(request)
  if (ageHours === null) return null
  if (ageHours < config.minAgeHours || ageHours > config.maxAgeHours) return null
  if (isClosedStatus(config, request)) return null

  const ticketId = request.id
  const groupName = normalizeText(request.group?.name) || config.groupNames.triage
  const status = normalizeText(request.status?.name) || 'Unknown'
  const priority = normalizeText(request.priority?.name) || 'Low'
  const subject = normalizeText(request.subject) || '-'
  const requester = normalizeText(request.requester?.name) || normalizeText(request.requester?.email_id) || 'Unknown requester'
  const createdAt = normalizeText(request.created_time?.display_value) || '-'
  const hasTechnician = Boolean(normalizeText(request.technician?.name))
  const hasIctTechnician = Boolean(normalizeText(request.udf_fields?.udf_pick_601))

  if (hasTechnician && hasIctTechnician) return null

  const reason = !hasTechnician && !hasIctTechnician ? 'missing_assigned_and_ict' : !hasTechnician ? 'missing_assigned' : 'missing_ict'

  return {
    ticketId,
    groupName,
    subject,
    requester,
    status,
    priority,
    createdAt,
    ageHours,
    hasTechnician,
    hasIctTechnician,
    reason,
  }
}

function buildNotificationMessage(candidate: DispatcherCandidate): string {
  return [
    '*Dispatcher assignment check*',
    `Ticket ID: ${candidate.ticketId}`,
    `Group: ${candidate.groupName}`,
    `Status: ${candidate.status}`,
    `Priority: ${candidate.priority}`,
    `Requester: ${candidate.requester}`,
    `Created: ${candidate.createdAt}`,
    `Subject: ${candidate.subject}`,
    `Reason: ${candidate.reason}`,
    candidate.targetIctTechnician ? `Suggested ICT: ${candidate.targetIctTechnician}` : '',
    `Link: ${buildTicketLink(candidate.ticketId)}`,
  ].join('\n')
}

function buildDigestMessage(candidates: DispatcherCandidate[], digestMaxItems: number): string {
  const lines: string[] = ['*Dispatcher digest*', `Total: ${candidates.length}`]
  const maxItems = Math.min(candidates.length, digestMaxItems)

  for (let index = 0; index < maxItems; index += 1) {
    const candidate = candidates[index]
    const suffix = candidate.targetIctTechnician ? ` | ${candidate.targetIctTechnician}` : ''
    lines.push(`${index + 1}. ${candidate.ticketId} | ${candidate.groupName} | ${candidate.subject}${suffix}`)
  }

  if (candidates.length > maxItems) {
    lines.push(`(+${candidates.length - maxItems} more)`)
  }

  return lines.join('\n')
}

function hoursSinceIso(iso: string | null | undefined): number | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return (Date.now() - date.getTime()) / (1000 * 60 * 60)
}

function computeNotificationHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 24)
}

function buildReminderMessage(args: {
  ticketId: string
  kind: 'unassigned' | 'unpicked_ict' | 'assigned_open'
  subject: string
  status: string
  groupName: string
  ictTechnician: string
  ageHours: number
  reason: string
}): string {
  const lines: string[] = []
  lines.push('*Ticket reminder*')
  lines.push(`Ticket ID: ${args.ticketId}`)
  lines.push(`Kind: ${args.kind}`)
  if (args.groupName) lines.push(`Group: ${args.groupName}`)
  if (args.ictTechnician) lines.push(`ICT: ${args.ictTechnician}`)
  if (args.status) lines.push(`Status: ${args.status}`)
  if (args.subject) lines.push(`Subject: ${args.subject}`)
  lines.push(`Age: ${Math.floor(args.ageHours)}h`)
  lines.push(`Link: ${buildTicketLink(args.ticketId)}`)
  lines.push(`Reason: ${args.reason}`)
  return lines.join('\n')
}

async function planAction(args: {
  config: DispatcherConfig
  requestObj: ServiceDeskRequest
  contacts: TechnicianContact[]
  loadByGroupIct: Map<string, Map<string, number>>
  leaveStatusByIctName: LeaveStatusByIctName | null
}): Promise<PlannedAction> {
  const { config, requestObj, contacts, loadByGroupIct, leaveStatusByIctName } = args
  const ticketId = requestObj.id
  const assignedGroupName = normalizeText(requestObj.technician?.name)
  const serviceDeskGroupName = normalizeText(requestObj.group?.name)
  const groupName = assignedGroupName || serviceDeskGroupName
  const ictTechnician = normalizeText(requestObj.udf_fields?.udf_pick_601)

  const isGroupMissing = assignedGroupName.length === 0
  const isIctTechnicianMissing = ictTechnician.length === 0 || ictTechnician.toLowerCase() === 'ict helpdesk'

  if (ictTechnician && isGroupMissing) {
    const contact = getContactByIctTechnicianName(ictTechnician)
    const inferredGroup = normalizeText(contact?.technician)
    if (inferredGroup) {
      return { kind: 'update', ticketId, targetGroupName: inferredGroup, reason: 'infer_group_from_ict_technician', notify: false }
    }
  }

  if (isGroupMissing && serviceDeskGroupName) {
    const picked = pickIctTechnicianByLoad({
      config,
      ticketId,
      groupName: serviceDeskGroupName,
      contacts,
      loadByGroupIct,
      leaveStatusByIctName,
    })
    return {
      kind: 'update',
      ticketId,
      targetGroupName: serviceDeskGroupName,
      targetIctTechnician: isIctTechnicianMissing ? picked?.ict_name : undefined,
      reason: 'mirror_group_to_technician',
      notify: false,
    }
  }

  if (isGroupMissing) {
    const decision = await routeTicket(config, requestObj)
    const picked = pickIctTechnicianByLoad({
      config,
      ticketId,
      groupName: decision.targetGroupName,
      contacts,
      loadByGroupIct,
      leaveStatusByIctName,
    })
    return {
      kind: 'update',
      ticketId,
      targetGroupName: decision.targetGroupName,
      targetIctTechnician: isIctTechnicianMissing ? picked?.ict_name : undefined,
      reason: decision.reason,
      notify: config.notifyMode === 'direct',
    }
  }

  if (isIctTechnicianMissing && groupName) {
    const picked = pickIctTechnicianByLoad({
      config,
      ticketId,
      groupName,
      contacts,
      loadByGroupIct,
      leaveStatusByIctName,
    })
    if (picked) {
      return { kind: 'update', ticketId, targetIctTechnician: picked.ict_name, reason: 'assign_ict_by_load', notify: false }
    }
    return { kind: 'skip', ticketId, reason: 'no_available_ict_after_leave_filter' }
  }

  return { kind: 'skip', ticketId, reason: 'already_assigned_or_not_actionable' }
}

async function sendDirectNotifications(args: {
  messaging: MessagingService
  phones: string[]
  message: string
}): Promise<{ sent: number; failed: number }> {
  let sent = 0
  let failed = 0

  for (const phone of args.phones) {
    try {
      await args.messaging.sendText({
        chatId: phoneNumberFormatter(phone),
        text: args.message,
      })
      sent += 1
    } catch {
      failed += 1
    }
  }

  return { sent, failed }
}

function summarizeLeaveStatusByIctName(leaveStatusByIctName: LeaveStatusByIctName | null): {
  loaded: boolean
  matched: number
  onsite: number
  offsite: number
} {
  if (!leaveStatusByIctName) {
    return { loaded: false, matched: 0, onsite: 0, offsite: 0 }
  }

  let matched = 0
  let onsite = 0
  let offsite = 0
  for (const leave of leaveStatusByIctName.values()) {
    if (!leave.found) continue
    matched += 1
    if (leave.onsite) onsite += 1
    else offsite += 1
  }

  return { loaded: true, matched, onsite, offsite }
}

function loadLeaveStatusByIctName(config: DispatcherConfig, contacts: TechnicianContact[]): LeaveStatusByIctName | null {
  if (!config.leaveScheduleEnabled) return null

  try {
    const dateIso = getTodayIsoDateForOffsetHours(config.leaveScheduleTzOffsetHours)
    const scheduleIndex = buildLeaveScheduleIndexForDate({
      xlsxPath: config.leaveScheduleXlsxPath,
      sheetName: config.leaveScheduleSheetName,
      dateIsoYyyyMmDd: dateIso,
      dateHeaderRow1Based: 9,
      dataStartRow1Based: 10,
      dateShiftDays: config.leaveScheduleDateShiftDays,
    })

    const byIct: LeaveStatusByIctName = new Map()
    for (const contact of contacts) {
      const nameForSchedule = contact.leave_schedule_name ?? contact.ict_name ?? contact.name
      const match = resolveLeaveScheduleEntry({
        scheduleIndex,
        personName: nameForSchedule,
        allowFuzzy: config.leaveScheduleAllowFuzzy,
        similarityThreshold: config.leaveScheduleSimilarityThreshold,
      })

      if (!match) {
        byIct.set(contact.ict_name, { found: false, onsite: false, status: null, matchedKey: null })
        continue
      }

      byIct.set(contact.ict_name, {
        found: true,
        onsite: match.entry.onsite,
        status: match.entry.status,
        matchedKey: match.matchedKey,
      })
    }

    return byIct
  } catch (error) {
    console.error(`Leave schedule load failed, continuing without filtering: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

async function runScanOnce(args: { config: DispatcherConfig; messaging: MessagingService }): Promise<{
  stats: DispatcherStats
  candidates: DispatcherCandidate[]
  leaveSchedule: {
    loaded: boolean
    matched: number
    onsite: number
    offsite: number
  }
}> {
  const stats: DispatcherStats = {
    scanned: 0,
    matched: 0,
    assigned: 0,
    notified: 0,
    skipped: 0,
    errors: 0,
  }

  const lookbackDays = Math.max(1, Math.ceil(args.config.maxAgeHours / 24))
  const requestIds = (await getAllRequests(lookbackDays)).slice(0, args.config.maxTicketsPerRun)
  const requests = await Promise.all(requestIds.map((requestId) => viewRequest(requestId)))
  const contacts = listTechnicianContacts()
  const leaveStatusByIctName = loadLeaveStatusByIctName(args.config, contacts)
  const loadByGroupIct = new Map<string, Map<string, number>>()
  const candidates: DispatcherCandidate[] = []
  const notificationQueue: Array<{
    ticketId: string
    notifyGroupName: string
    subject: string
    status: string
    priority: string
    requester: string
    createdAt: string
    reason: string
    targetGroupName?: string
    targetIctTechnician?: string
    state: Awaited<ReturnType<typeof loadPreviousTicketState>>
  }> = []
  const digestCandidates: DispatcherCandidate[] = []
  const shouldUseTicketState = !(args.config.dryRun && args.config.dryRunIgnoreRedisState)
  let remindersLeft = args.config.reminderMaxPerRun

  for (const request of requests) {
    if (!request || isClosedStatus(args.config, request)) continue

    const ict = normalizeText(request.udf_fields?.udf_pick_601)
    if (!ict) continue

    let groupName = normalizeText(request.technician?.name) || normalizeText(request.group?.name)
    if (!groupName) {
      const contact = getContactByIctTechnicianName(ict)
      groupName = normalizeText(contact?.technician)
    }
    if (!groupName) continue

    const groupLoad = loadByGroupIct.get(groupKey(groupName)) ?? new Map<string, number>()
    groupLoad.set(ict, (groupLoad.get(ict) ?? 0) + 1)
    loadByGroupIct.set(groupKey(groupName), groupLoad)
  }

  for (const request of requests) {
    stats.scanned += 1
    if (!request) {
      stats.errors += 1
      continue
    }

    const baseCandidate = buildCandidate(args.config, request)
    if (!baseCandidate) {
      stats.skipped += 1
      continue
    }

    const state = shouldUseTicketState ? await loadPreviousTicketState(request.id) : null
    const existingGroup = normalizeText(request.technician?.name)
    const existingServiceDeskGroup = normalizeText(request.group?.name)
    const existingIct = normalizeText(request.udf_fields?.udf_pick_601)
    const ageHours = baseCandidate.ageHours

    if (args.config.reminderMode !== 'none' && remindersLeft > 0) {
      const isGroupMissing = existingGroup.length === 0 && existingServiceDeskGroup.length === 0
      const isIctMissing = existingIct.length === 0 || existingIct.toLowerCase() === 'ict helpdesk'

      let reminderKind: 'unassigned' | 'unpicked_ict' | 'assigned_open' | null = null
      let reminderTarget = ''
      let reminderPhones: string[] = []
      let reminderReason = ''

      if (isGroupMissing && args.config.remindUnassignedAfterHours > 0 && ageHours >= args.config.remindUnassignedAfterHours) {
        reminderKind = 'unassigned'
        reminderTarget = args.config.groupNames.triage
        reminderPhones = resolveContactsForGroup(reminderTarget, contacts).map((contact) => contact.phone)
        reminderReason = `unassigned>${args.config.remindUnassignedAfterHours}h`
      } else if (
        !isGroupMissing &&
        isIctMissing &&
        args.config.remindUnpickedIctAfterHours > 0 &&
        ageHours >= args.config.remindUnpickedIctAfterHours
      ) {
        reminderKind = 'unpicked_ict'
        reminderTarget = existingGroup || existingServiceDeskGroup
        reminderPhones = resolveContactsForGroup(reminderTarget, contacts).map((contact) => contact.phone)
        reminderReason = `unpicked_ict>${args.config.remindUnpickedIctAfterHours}h`
      } else if (
        !isGroupMissing &&
        !isIctMissing &&
        args.config.remindAssignedOpenAfterHours > 0 &&
        ageHours >= args.config.remindAssignedOpenAfterHours
      ) {
        reminderKind = 'assigned_open'
        reminderTarget = existingIct
        const ictContact = getContactByIctTechnicianName(existingIct)
        reminderPhones = ictContact?.phone
          ? [ictContact.phone]
          : resolveContactsForGroup(existingGroup || existingServiceDeskGroup, contacts).map((contact) => contact.phone)
        reminderReason = `assigned_open>${args.config.remindAssignedOpenAfterHours}h`
      }

      if (reminderKind && reminderPhones.length > 0) {
        const reminderHash = computeNotificationHash(`reminder|${reminderKind}|${request.id}|${reminderTarget}|${reminderReason}`)
        const sinceReminderHours = hoursSinceIso(state?.lastReminderAtIso)
        const inCooldown =
          typeof sinceReminderHours === 'number' &&
          Number.isFinite(sinceReminderHours) &&
          sinceReminderHours < args.config.reminderCooldownHours

        if (!inCooldown && state?.lastReminderHash !== reminderHash) {
          if (!args.config.dryRun && args.config.reminderMode === 'direct') {
            const result = await sendDirectNotifications({
              messaging: args.messaging,
              phones: reminderPhones,
              message: buildReminderMessage({
                ticketId: request.id,
                kind: reminderKind,
                subject: normalizeText(request.subject),
                status: normalizeText(request.status?.name),
                groupName: existingGroup,
                ictTechnician: existingIct,
                ageHours,
                reason: reminderReason,
              }),
            })
            if (result.sent > 0) {
              remindersLeft -= 1
              stats.notified += 1
              if (shouldUseTicketState) {
                await saveTicketState(request.id, {
                  technician: existingIct || undefined,
                  ticketStatus: normalizeText(request.status?.name) || undefined,
                  priority: normalizeText(request.priority?.name) || undefined,
                  lastActionAtIso: state?.lastActionAtIso,
                  lastAssignedGroupName: state?.lastAssignedGroupName ?? null,
                  lastAssignedIctTechnician: state?.lastAssignedIctTechnician ?? null,
                  lastNotifiedHash: state?.lastNotifiedHash ?? null,
                  lastReminderAtIso: new Date().toISOString(),
                  lastReminderHash: reminderHash,
                })
              }
            }
          }
        }
      }
    }

    const action = await planAction({
      config: args.config,
      requestObj: request,
      contacts,
      loadByGroupIct,
      leaveStatusByIctName,
    })

    if (action.kind === 'skip') {
      candidates.push({ ...baseCandidate, reason: action.reason })
      stats.skipped += 1
      continue
    }

    const candidate: DispatcherCandidate = {
      ...baseCandidate,
      reason: action.reason,
      targetGroupName: action.targetGroupName,
      targetIctTechnician: action.targetIctTechnician,
    }
    candidates.push(candidate)
    stats.matched += 1

    const hasGroupChange =
      typeof action.targetGroupName === 'string' &&
      action.targetGroupName.trim().length > 0 &&
      existingGroup.toLowerCase() !== action.targetGroupName.toLowerCase()
    const hasIctChange =
      typeof action.targetIctTechnician === 'string' &&
      action.targetIctTechnician.trim().length > 0 &&
      existingIct.toLowerCase() !== action.targetIctTechnician.toLowerCase()

    if (!hasGroupChange && !hasIctChange) {
      stats.skipped += 1
      continue
    }

    if (shouldUseTicketState) {
      const sinceLastActionHours = hoursSinceIso(state?.lastActionAtIso)
      const inManualBackoff =
        args.config.manualOverrideBackoffHours > 0 &&
        typeof sinceLastActionHours === 'number' &&
        Number.isFinite(sinceLastActionHours) &&
        sinceLastActionHours < args.config.manualOverrideBackoffHours
      const groupManualOverride =
        !!state?.lastAssignedGroupName && !!existingGroup && existingGroup.toLowerCase() !== state.lastAssignedGroupName.toLowerCase()
      const ictManualOverride =
        !!state?.lastAssignedIctTechnician &&
        !!existingIct &&
        existingIct.toLowerCase() !== state.lastAssignedIctTechnician.toLowerCase()
      if (inManualBackoff && ((groupManualOverride && hasGroupChange) || (ictManualOverride && hasIctChange))) {
        stats.skipped += 1
        continue
      }
    }

    if (stats.assigned >= args.config.maxAssignmentsPerRun) {
      stats.skipped += 1
      continue
    }

    if (!args.config.dryRun) {
      const result = await updateRequest(request.id, {
        groupName: hasGroupChange ? action.targetGroupName : undefined,
        technicianName: hasGroupChange ? action.targetGroupName : undefined,
        ictTechnician: hasIctChange ? action.targetIctTechnician : undefined,
      })
      if (!result.success) {
        stats.errors += 1
        continue
      }
    }

    stats.assigned += 1

    if (shouldUseTicketState) {
      await saveTicketState(request.id, {
        technician: (hasIctChange ? action.targetIctTechnician : existingIct) || undefined,
        ticketStatus: normalizeText(request.status?.name) || undefined,
        priority: normalizeText(request.priority?.name) || undefined,
        lastActionAtIso: new Date().toISOString(),
        lastAssignedGroupName: hasGroupChange ? action.targetGroupName ?? null : state?.lastAssignedGroupName ?? null,
        lastAssignedIctTechnician: hasIctChange ? action.targetIctTechnician ?? null : state?.lastAssignedIctTechnician ?? null,
        lastNotifiedHash: state?.lastNotifiedHash ?? null,
        lastReminderAtIso: state?.lastReminderAtIso ?? null,
        lastReminderHash: state?.lastReminderHash ?? null,
      })
    }

    if (hasGroupChange || hasIctChange) {
      if (args.config.notifyMode === 'digest') {
        digestCandidates.push(candidate)
      } else if (args.config.notifyMode === 'direct' && action.notify) {
        notificationQueue.push({
          ticketId: request.id,
          notifyGroupName: action.targetGroupName ?? existingGroup,
          subject: normalizeText(request.subject),
          status: normalizeText(request.status?.name),
          priority: normalizeText(request.priority?.name),
          requester: normalizeText(request.requester?.name) || normalizeText(request.requester?.email_id),
          createdAt: normalizeText(request.created_time?.display_value),
          reason: action.reason,
          targetGroupName: action.targetGroupName,
          targetIctTechnician: action.targetIctTechnician,
          state,
        })
      }
    }

    if (hasIctChange && action.targetIctTechnician) {
      const updatedGroupName = action.targetGroupName ?? existingGroup ?? baseCandidate.groupName
      const groupLoad = loadByGroupIct.get(groupKey(updatedGroupName)) ?? new Map<string, number>()
      groupLoad.set(action.targetIctTechnician, (groupLoad.get(action.targetIctTechnician) ?? 0) + 1)
      loadByGroupIct.set(groupKey(updatedGroupName), groupLoad)
    }
  }

  if (args.config.notifyMode === 'direct' && args.config.notifyMaxPerRun > 0) {
    let notifyLeft = args.config.notifyMaxPerRun

    for (const queued of notificationQueue) {
      if (notifyLeft <= 0) break
      const phones = resolveContactsForGroup(queued.notifyGroupName, contacts).map((contact) => contact.phone)
      if (phones.length === 0) continue

      const notificationHash = computeNotificationHash(
        `update|${queued.ticketId}|${queued.targetGroupName ?? ''}|${queued.targetIctTechnician ?? ''}|${queued.reason}`
      )
      if (shouldUseTicketState && queued.state?.lastNotifiedHash === notificationHash) continue

      if (!args.config.dryRun) {
        const result = await sendDirectNotifications({
          messaging: args.messaging,
          phones,
          message: buildNotificationMessage({
            ticketId: queued.ticketId,
            groupName: queued.notifyGroupName,
            subject: queued.subject,
            requester: queued.requester,
            status: queued.status,
            priority: queued.priority,
            createdAt: queued.createdAt,
            ageHours: 0,
            hasTechnician: true,
            hasIctTechnician: Boolean(queued.targetIctTechnician),
            reason: queued.reason,
            targetGroupName: queued.targetGroupName,
            targetIctTechnician: queued.targetIctTechnician,
          }),
        })
        if (result.sent > 0) {
          stats.notified += 1
          if (shouldUseTicketState) {
            await saveTicketState(queued.ticketId, {
              technician: queued.targetIctTechnician ?? undefined,
              lastActionAtIso: new Date().toISOString(),
              lastAssignedGroupName: queued.targetGroupName ?? queued.state?.lastAssignedGroupName ?? null,
              lastAssignedIctTechnician: queued.targetIctTechnician ?? queued.state?.lastAssignedIctTechnician ?? null,
              lastNotifiedHash: notificationHash,
              lastReminderAtIso: queued.state?.lastReminderAtIso ?? null,
              lastReminderHash: queued.state?.lastReminderHash ?? null,
              ticketStatus: queued.status || undefined,
              priority: queued.priority || undefined,
            })
          }
        }
      } else {
        stats.notified += 1
      }

      notifyLeft -= 1
    }
  }

  if (args.config.notifyMode === 'digest' && args.config.digestNumbers.length > 0 && digestCandidates.length > 0) {
    if (!args.config.dryRun) {
      const result = await sendDirectNotifications({
        messaging: args.messaging,
        phones: args.config.digestNumbers,
        message: buildDigestMessage(digestCandidates, args.config.digestMaxItems),
      })
      if (result.sent > 0) stats.notified += 1
    } else {
      stats.notified += 1
    }
  }

  return {
    stats,
    candidates,
    leaveSchedule: summarizeLeaveStatusByIctName(leaveStatusByIctName),
  }
}

export function startHelpdeskDispatcher(args: { messaging: MessagingService }): { stop: () => void } {
  const config = buildConfig()
  if (!config.enabled) {
    console.log('Helpdesk dispatcher disabled (DISPATCHER_ENABLED=false).')
    return { stop: () => undefined }
  }

  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let runCount = 0

  const tick = async () => {
    if (stopped) return

    runCount += 1
    try {
      const result = await runScanOnce({ config, messaging: args.messaging })
      console.log(
        JSON.stringify(
          {
            scope: 'helpdesk_dispatcher',
            runCount,
            mode: config.dryRun ? 'dry_run' : 'live',
            notifyMode: config.notifyMode,
            reminderMode: config.reminderMode,
            scanIntervalSeconds: config.scanIntervalSeconds,
            minAgeHours: config.minAgeHours,
            maxAgeHours: config.maxAgeHours,
            maxTicketsPerRun: config.maxTicketsPerRun,
            maxAssignmentsPerRun: config.maxAssignmentsPerRun,
            notifyMaxPerRun: config.notifyMaxPerRun,
            reminderMaxPerRun: config.reminderMaxPerRun,
            manualOverrideBackoffHours: config.manualOverrideBackoffHours,
            dryRunIgnoreRedisState: config.dryRunIgnoreRedisState,
            leaveScheduleEnabled: config.leaveScheduleEnabled,
            leaveSchedule: result.leaveSchedule,
            stats: result.stats,
            candidates: result.candidates.map((candidate) => ({
              ticketId: candidate.ticketId,
              groupName: candidate.groupName,
              targetGroupName: candidate.targetGroupName,
              targetIctTechnician: candidate.targetIctTechnician,
              reason: candidate.reason,
              hasTechnician: candidate.hasTechnician,
              hasIctTechnician: candidate.hasIctTechnician,
            })),
          },
          null,
          2
        )
      )
    } catch (error) {
      console.error(`Dispatcher scan error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const scheduleNext = () => {
    if (stopped) return
    timer = setTimeout(() => {
      void tick().finally(() => scheduleNext())
    }, config.scanIntervalSeconds * 1000)
  }

  void tick().finally(() => {
    if (config.runOnce) {
      stopped = true
      return
    }
    scheduleNext()
  })

  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
