import { pino } from 'pino';
import qrcode from 'qrcode';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { WASocket, proto, WAMessage } from '@whiskeysockets/baileys';
import type { Server as SocketIoServer } from 'socket.io';
import { createBaileysChannelService } from '../channel/baileysChannel.js';
import type { InMemoryStore } from './store.js';
import { resolveSenderNumber } from './utils.js';
import { handleN8nIntegration, type N8nAttachment, type N8nQuotedMessage } from '../integrations/n8n.js';
import {
  findAdUserByPhone,
  findUsersByCommonName,
  getBitLockerInfo,
  getLapsDiagnostics,
  getLapsInfo,
  renderFindUserCaption,
  resetPassword,
  unlockAccount,
  type AdUserInfo,
} from '../integrations/ldap.js';
import {
  buildGetAssetReply,
  CATEGORY_MAPPING,
  getExpiringLicenses,
  getLicenseByName,
  getLicenses,
  getLicenseUtilization,
} from '../integrations/snipeIt.js';
import {
  addTechnicianContact,
  deleteTechnicianContact,
  getContactByPhone,
  getTechnicianContactsPath,
  getTechnicianContactById,
  listTechnicianContacts,
  normalizeTechnicianPhoneNumber,
  saveTechnicianContacts,
  searchTechnicianContacts,
  updateTechnicianContact,
} from '../integrations/technicianContacts.js';
import type { TechnicianContact, TechnicianContactUpdateField } from '../integrations/technicianContacts.js';
import { claimTicketNotification, loadTicketNotification, unclaimTicketNotification } from '../tickets/claimStore.js';
import { updateRequest, viewRequest } from '../integrations/ticketHandle.js';
import {
  buildLeaveScheduleIndexForDate,
  getTodayIsoDateForOffsetHours,
  normalizeScheduleBaseName,
  resolveLeaveScheduleEntry,
} from '../../leaveScheduleCheck.js';

let sock: WASocket | undefined;
const fatalLogger = pino({ level: 'fatal' });
const mediaLogger = fatalLogger;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectInFlight = false;
let reconnectAttempt = 0;
let pairingCodeRequested = false;
let pairingRequestInFlight = false;
const channel = createBaileysChannelService();

const MESSAGE_BUFFER_ENABLED = process.env.MESSAGE_BUFFER_ENABLED === 'true';
const MESSAGE_BUFFER_TIMEOUT_MS = Number(process.env.MESSAGE_BUFFER_TIMEOUT ?? '3000');
const PRESENCE_BUFFER_ENABLED = process.env.PRESENCE_BUFFER_ENABLED === 'true';
const PRESENCE_BUFFER_MAX_TIMEOUT_MS = Number(process.env.PRESENCE_BUFFER_MAX_TIMEOUT ?? '10000');
const PRESENCE_BUFFER_STOP_DELAY_MS = Number(process.env.PRESENCE_BUFFER_STOP_DELAY ?? '2000');
const PRESENCE_SUBSCRIPTION_ENABLED = process.env.PRESENCE_SUBSCRIPTION_ENABLED === 'true';
const DEBUG_TICKET_REACTIONS = process.env.DEBUG_TICKET_REACTIONS === 'true';
const DEBUG_LAPS_AUTH = process.env.DEBUG_LAPS_AUTH === 'true';

type DebugValue = string | number | boolean | null | undefined;

function maskPhoneForLogs(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length <= 4) return digits;
  const prefix = digits.slice(0, 3);
  const suffix = digits.slice(-2);
  return `${prefix}***${suffix}`;
}

function debugLapsAuth(event: string, details: Record<string, DebugValue>): void {
  if (!DEBUG_LAPS_AUTH) return;
  try {
    console.log('[laps-auth]', JSON.stringify({ event, ...details }));
  } catch {
    console.log('[laps-auth]', event);
  }
}

type MediaSendMode = 'base64' | 'file_url' | 'auto';

type WaVersion = [number, number, number];

function parseWaVersionEnv(raw: string | undefined): WaVersion | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (!cleaned) return null;
  const parts = cleaned.split(/[,\s]+/).filter(Boolean);
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => Number(p));
  if (!nums.every((n) => Number.isInteger(n) && n > 0)) return null;
  return [nums[0], nums[1], nums[2]];
}

function isReadableStream(value: unknown): value is NodeJS.ReadableStream {
  if (!value || typeof value !== 'object') return false;
  const v = value as { pipe?: unknown; on?: unknown };
  return typeof v.pipe === 'function' && typeof v.on === 'function';
}

async function toBufferFromDownloadedMedia(downloaded: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(downloaded)) return downloaded;
  if (downloaded instanceof Uint8Array) return Buffer.from(downloaded);
  if (isReadableStream(downloaded)) {
    const chunks: Buffer[] = [];
    for await (const chunkUnknown of downloaded as AsyncIterable<unknown>) {
      if (Buffer.isBuffer(chunkUnknown)) {
        chunks.push(chunkUnknown);
        continue;
      }
      if (chunkUnknown instanceof Uint8Array) {
        chunks.push(Buffer.from(chunkUnknown));
        continue;
      }
      if (typeof chunkUnknown === 'string') {
        chunks.push(Buffer.from(chunkUnknown));
        continue;
      }
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Unsupported media download type');
}

function readMediaSendMode(): MediaSendMode {
  const raw = process.env.N8N_MEDIA_SEND_MODE;
  if (!raw) return 'auto';
  const v = raw.trim().toLowerCase();
  if (v === 'base64' || v === 'file_url' || v === 'auto') return v;
  return 'auto';
}

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i <= 0) return fallback;
  return i;
}

function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function readPairingPhone(): string | null {
  const raw = process.env.WA_PAIRING_PHONE;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const digits = normalizeTechnicianPhoneNumber(raw);
  return digits.length > 0 ? digits : null;
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendChannelText(chatId: string, text: string): Promise<void> {
  await channel.sendMessage(chatId, { kind: 'text', text });
}

async function sendChannelImage(chatId: string, buffer: Buffer, caption: string): Promise<void> {
  await channel.sendMessage(chatId, {
    kind: 'image',
    source: { kind: 'buffer', buffer },
    caption,
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Timeout')), ms);
    }),
  ]);
}

function resolveUploadsDir(): string {
  const rootDir = process.cwd();
  const dataRaw = process.env.DATA_DIR;
  const dataDir = dataRaw
    ? path.isAbsolute(dataRaw) ? dataRaw : path.join(rootDir, dataRaw)
    : rootDir;
  return path.join(dataDir, 'uploads');
}

function resolvePublicBaseUrl(): string | null {
  const raw = process.env.PUBLIC_BASE_URL;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function guessFileExtensionFromMime(mime: string, fallback: string): string {
  const m = mime.toLowerCase();
  if (m.includes('video/mp4')) return 'mp4';
  if (m.includes('video/quicktime')) return 'mov';
  if (m.includes('image/png')) return 'png';
  if (m.includes('image/webp')) return 'webp';
  if (m.includes('image/jpeg')) return 'jpg';
  if (m.includes('audio/ogg')) return 'ogg';
  if (m.includes('audio/mpeg')) return 'mp3';
  if (m.includes('application/pdf')) return 'pdf';
  return fallback;
}

function buildUploadsFileUrl(baseUrl: string, fileName: string): string {
  return `${baseUrl}/uploads/${encodeURIComponent(fileName)}`;
}

type TicketReactionDebugPayload = {
  event: 'claim' | 'unclaim';
  source?: 'messages.reaction' | 'messages.upsert';
  remoteJid: string;
  messageId: string;
  reactionText?: string | null;
  participantRaw?: string;
  participantResolved?: string;
  participantDigits?: string | null;
  sockUserJid?: string;
  sockDigits?: string | null;
  ignoredReason?: string;
};

function logTicketReactionDebug(payload: TicketReactionDebugPayload): void {
  if (!DEBUG_TICKET_REACTIONS) return;
  console.log('[ticket-reaction]', JSON.stringify(payload));
}

const recentReactionEvents = new Map<string, number>();

function buildReactionEventKey(args: {
  remoteJid: string;
  messageId: string;
  participantRaw: string;
  reactionText: string | null;
}): string {
  return `${args.remoteJid}|${args.messageId}|${args.participantRaw}|${args.reactionText ?? ''}`;
}

function shouldProcessReactionEvent(key: string): boolean {
  const now = Date.now();
  for (const [k, t] of recentReactionEvents) {
    if (now - t > 15_000) recentReactionEvents.delete(k);
  }
  const last = recentReactionEvents.get(key);
  if (last !== undefined && now - last < 5_000) return false;
  recentReactionEvents.set(key, now);
  return true;
}

type PresenceState = { isTyping: boolean; lastUpdateMs: number };
type BufferedMessage = {
  msg: proto.IWebMessageInfo;
  text: string;
  attachments: N8nAttachment[];
  remoteJid: string;
  senderNumber: string;
  pushName: string;
  isGroup: boolean;
  shouldReply: boolean;
  messageType: ParsedIncomingMessage['messageType'];
  mentionedJids: string[];
  quotedMessage: N8nQuotedMessage | null;
};

type MessageBuffer = {
  items: BufferedMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  typingTimer: ReturnType<typeof setTimeout> | null;
  lastMessageTimeMs: number;
  isTyping: boolean;
};

const messageBuffers = new Map<string, MessageBuffer>();
const presenceStatus = new Map<string, PresenceState>();

const adUserCache = new Map<string, { value: AdUserInfo | null; expiresAtMs: number }>();

function getAdUserCacheTtlMs(): number {
  const raw = process.env.ADUSER_CACHE_TTL_MS;
  const value = raw ? Number(raw) : 600_000;
  if (!Number.isFinite(value) || value <= 0) return 600_000;
  return value;
}

async function resolveAdUser(args: { senderDigits: string | null; senderJid: string; pushName: string | null }): Promise<AdUserInfo | null> {
  const key = args.senderDigits ?? args.senderJid;
  const cached = adUserCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAtMs > now) return cached.value;

  const value = await findAdUserByPhone({ phone: key, pushName: args.pushName });
  adUserCache.set(key, { value, expiresAtMs: now + getAdUserCacheTtlMs() });
  return value;
}

function getBufferKey(args: { remoteJid: string; senderNumber: string }): string {
  return `${args.remoteJid}|${args.senderNumber}`;
}

function subscribeToPresence(args: { sock: WASocket; jid: string }): void {
  if (!PRESENCE_SUBSCRIPTION_ENABLED) return;
  try {
    args.sock.presenceSubscribe(args.jid);
  } catch {
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

type ReplyGatewayAction = 'reply' | 'no_reply' | 'mute';

type ReplyGatewayDecision = {
  action: ReplyGatewayAction;
  reason: string;
};

type ReplyMuteState = {
  mutedAtIso: string;
  reason: string;
};

const replyMuteStateBySender = new Map<string, ReplyMuteState>();

const REPLY_GATEWAY_ENABLED = process.env.REPLY_GATEWAY_ENABLED !== 'false';
const REPLY_GATEWAY_AI_ENABLED = process.env.REPLY_GATEWAY_AI_ENABLED !== 'false';
const REPLY_GATEWAY_MODEL = (process.env.REPLY_GATEWAY_MODEL?.trim() || 'gpt-4o-mini').trim();
const REPLY_GATEWAY_DEBUG = process.env.REPLY_GATEWAY_DEBUG === 'true';

type ReplyGatewayDecisionSource = 'mute_state' | 'heuristic' | 'ai' | 'default';

type ReplyGatewayLogPayload = {
  senderKey: string;
  senderNumber: string;
  action: ReplyGatewayAction;
  reason: string;
  source: ReplyGatewayDecisionSource;
  initialShouldReply: boolean;
  hasAttachment: boolean;
  messageLen: number;
  messagePreview: string;
};

function logReplyGatewayDecision(payload: ReplyGatewayLogPayload): void {
  if (!REPLY_GATEWAY_DEBUG && payload.action === 'reply') return;
  console.log('[reply-gateway]', JSON.stringify(payload));
}

function getReplyGatewaySenderKey(senderJid: string): string {
  return extractPhoneDigitsFromJid(senderJid) ?? senderJid;
}

function normalizeGatewayText(text: string): string {
  return text
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decideReplyGatewayHeuristic(messageText: string, hasAttachment: boolean): ReplyGatewayDecision | null {
  const normalized = normalizeGatewayText(messageText);
  const lower = normalized.toLowerCase();

  if (hasAttachment) return { action: 'reply', reason: 'has_attachment' };

  const greetingPatterns: RegExp[] = [
    /^hi\b[!.\s]*$/i,
    /^hello\b[!.\s]*$/i,
    /^hey\b[!.\s]*$/i,
    /^halo\b[!.\s]*$/i,
    /^hai\b[!.\s]*$/i,
    /^pagi\b[!.\s]*$/i,
    /^siang\b[!.\s]*$/i,
    /^sore\b[!.\s]*$/i,
    /^malam\b[!.\s]*$/i,
    /^ass?alamu\s*'?alaikum\b[!.\s]*$/i,
    /^selamat\s+(pagi|siang|sore|malam)\b[!.\s]*$/i,
  ];
  if (greetingPatterns.some((p) => p.test(lower))) return { action: 'reply', reason: 'greeting' };

  const mutePatterns: RegExp[] = [
    /\b(stop|stahp)\b.*\b(reply|replies|balas|jawab)\b/i,
    /\b(don'?t|do not)\b\s+\b(reply|respond)\b/i,
    /\bno\s+need\b\s+\b(to\s+)?(reply|respond)\b/i,
    /\b(jangan|ga|gak|nggak)\s+\b(balas|jawab)\b/i,
    /\b(jangan)\s+\b(ganggu|spam)\b/i,
    /\b(annoying|spammy)\b/i,
    /\b(shut\s*up)\b/i,
    /\b(diam)\b/i,
    /\b(berisik)\b/i,
  ];
  if (mutePatterns.some((p) => p.test(lower))) return { action: 'mute', reason: 'explicit_stop' };

  const shortAcks = new Set<string>([
    'ok',
    'oke',
    'okay',
    'k',
    'sip',
    'siap',
    'noted',
    'thanks',
    'thank you',
    'thx',
    'makasih',
    'terima kasih',
    'ty',
  ]);
  if (shortAcks.has(lower)) return { action: 'no_reply', reason: 'ack' };

  if (/[?？]/.test(normalized)) return { action: 'reply', reason: 'question_mark' };
  if (/\b(how|why|what|when|where|who|which)\b/i.test(lower)) return { action: 'reply', reason: 'question_word' };
  if (/\b(bagaimana|kenapa|apa|kapan|dimana|siapa|yang mana)\b/i.test(lower)) return { action: 'reply', reason: 'question_word_id' };

  if (normalized.length <= 2) return { action: 'no_reply', reason: 'very_short' };
  return null;
}

function getOptionalEnvString(key: string): string | null {
  const raw = process.env[key];
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getOpenAiClientOrNull(): OpenAI | null {
  const apiKey = getOptionalEnvString('OPENAI_API_KEY');
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

function tryParseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isReplyGatewayAction(value: unknown): value is ReplyGatewayAction {
  return value === 'reply' || value === 'no_reply' || value === 'mute';
}

function coerceGatewayDecision(value: unknown): ReplyGatewayDecision | null {
  if (!isRecordValue(value)) return null;
  const action = value.action;
  const reason = value.reason;
  if (!isReplyGatewayAction(action)) return null;
  if (typeof reason !== 'string') return null;
  return { action, reason };
}

async function decideReplyGatewayAi(messageText: string, hasAttachment: boolean): Promise<ReplyGatewayDecision | null> {
  if (!REPLY_GATEWAY_ENABLED || !REPLY_GATEWAY_AI_ENABLED) return null;
  if (hasAttachment) return { action: 'reply', reason: 'has_attachment' };

  const openai = getOpenAiClientOrNull();
  if (!openai) return null;

  const maxChars = readPositiveIntEnv('REPLY_GATEWAY_AI_MAX_CHARS', 900);
  const content = normalizeGatewayText(messageText).slice(0, maxChars);
  if (content.length === 0) return { action: 'no_reply', reason: 'empty' };

  const system =
    'You are a WhatsApp bot reply gateway. Decide whether the bot should reply to the user message. ' +
    'If the user is annoyed or explicitly asks to stop, choose action "mute" (stop replying until /unmute). ' +
    'Always reply to greetings (e.g., hi/hello/hey/halo/hai/selamat pagi). ' +
    'If no response is needed (acknowledgment, filler), choose "no_reply". Otherwise choose "reply". ' +
    'Return JSON only with keys: action, reason.';
  const user = `MESSAGE:\n${content}`;

  try {
    const completion = await openai.chat.completions.create({
      model: REPLY_GATEWAY_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
    });

    const raw = completion.choices[0]?.message?.content;
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    const parsed = tryParseJsonObject(raw.trim());
    return coerceGatewayDecision(parsed);
  } catch {
    return null;
  }
}

async function applyReplyGateway(args: {
  senderNumber: string;
  isGroup: boolean;
  messageText: string;
  attachments: N8nAttachment[];
  initialShouldReply: boolean;
}): Promise<{ shouldReply: boolean }> {
  if (!REPLY_GATEWAY_ENABLED) return { shouldReply: args.initialShouldReply };
  if (args.isGroup) return { shouldReply: args.initialShouldReply };
  if (!args.initialShouldReply) return { shouldReply: false };

  const senderKey = getReplyGatewaySenderKey(args.senderNumber);
  const existingMute = replyMuteStateBySender.get(senderKey);
  if (existingMute) {
    const normalized = normalizeGatewayText(args.messageText);
    const previewMax = readPositiveIntEnv('REPLY_GATEWAY_LOG_PREVIEW_CHARS', 160);
    logReplyGatewayDecision({
      senderKey,
      senderNumber: args.senderNumber,
      action: 'no_reply',
      reason: `muted:${existingMute.reason}`,
      source: 'mute_state',
      initialShouldReply: args.initialShouldReply,
      hasAttachment: args.attachments.length > 0,
      messageLen: normalized.length,
      messagePreview: truncateText(normalized, previewMax),
    });
    return { shouldReply: false };
  }

  const hasAttachment = args.attachments.length > 0;
  const heuristic = decideReplyGatewayHeuristic(args.messageText, hasAttachment);
  const decision = heuristic ?? (await decideReplyGatewayAi(args.messageText, hasAttachment));
  const source: ReplyGatewayDecisionSource = heuristic ? 'heuristic' : decision ? 'ai' : 'default';
  const finalDecision: ReplyGatewayDecision = decision ?? { action: 'reply', reason: 'default' };

  const normalized = normalizeGatewayText(args.messageText);
  const previewMax = readPositiveIntEnv('REPLY_GATEWAY_LOG_PREVIEW_CHARS', 160);
  logReplyGatewayDecision({
    senderKey,
    senderNumber: args.senderNumber,
    action: finalDecision.action,
    reason: finalDecision.reason,
    source,
    initialShouldReply: args.initialShouldReply,
    hasAttachment,
    messageLen: normalized.length,
    messagePreview: truncateText(normalized, previewMax),
  });

  if (finalDecision.action === 'mute') {
    replyMuteStateBySender.set(senderKey, {
      mutedAtIso: new Date().toISOString(),
      reason: finalDecision.reason,
    });
    return { shouldReply: false };
  }

  return { shouldReply: finalDecision.action === 'reply' };
}

function extractPresenceItems(payloadUnknown: unknown): Array<{ remoteJid: string; participantJid: string; presence: string }> {
  if (!isRecordValue(payloadUnknown)) return [];
  const id = payloadUnknown.id;
  const presencesUnknown = payloadUnknown.presences;
  if (typeof id !== 'string' || !isRecordValue(presencesUnknown)) return [];

  const out: Array<{ remoteJid: string; participantJid: string; presence: string }> = [];
  for (const [participantJid, value] of Object.entries(presencesUnknown)) {
    if (!isRecordValue(value)) continue;
    const lastKnownPresence = value.lastKnownPresence;
    if (typeof lastKnownPresence !== 'string') continue;
    out.push({ remoteJid: id, participantJid, presence: lastKnownPresence });
  }
  return out;
}

function isPresenceTyping(presence: string): boolean {
  return presence === 'composing' || presence === 'recording';
}

function scheduleFlush(args: {
  key: string;
  buffer: MessageBuffer;
  forceMaxTimeout: boolean;
}): void {
  const buffer = args.buffer;
  if (buffer.timer) clearTimeout(buffer.timer);
  if (buffer.typingTimer) clearTimeout(buffer.typingTimer);
  buffer.typingTimer = null;

  if (PRESENCE_BUFFER_ENABLED) {
    buffer.timer = setTimeout(
      () => {
        void flushMessageBuffer(args.key);
      },
      args.forceMaxTimeout ? PRESENCE_BUFFER_MAX_TIMEOUT_MS : PRESENCE_BUFFER_STOP_DELAY_MS
    );
    return;
  }

  buffer.timer = setTimeout(() => {
    void flushMessageBuffer(args.key);
  }, MESSAGE_BUFFER_TIMEOUT_MS);
}

function addToMessageBuffer(item: BufferedMessage): boolean {
  if (!MESSAGE_BUFFER_ENABLED) return false;

  const key = getBufferKey({ remoteJid: item.remoteJid, senderNumber: item.senderNumber });
  const now = Date.now();

  if (!messageBuffers.has(key)) {
    messageBuffers.set(key, {
      items: [],
      timer: null,
      typingTimer: null,
      lastMessageTimeMs: now,
      isTyping: false,
    });

    const currentSock = sock;
    if (currentSock) {
      subscribeToPresence({ sock: currentSock, jid: item.senderNumber });
    }
  }

  const buffer = messageBuffers.get(key);
  if (!buffer) return false;

  buffer.items.push(item);
  buffer.lastMessageTimeMs = now;

  const presence = presenceStatus.get(key);
  const currentlyTyping = Boolean(presence?.isTyping);
  scheduleFlush({ key, buffer, forceMaxTimeout: currentlyTyping });
  return true;
}

async function flushMessageBuffer(key: string): Promise<void> {
  const buffer = messageBuffers.get(key);
  if (!buffer || buffer.items.length === 0) return;

  if (buffer.timer) clearTimeout(buffer.timer);
  if (buffer.typingTimer) clearTimeout(buffer.typingTimer);
  messageBuffers.delete(key);

  const combinedText = buffer.items.map((i) => i.text).filter((t) => t.trim().length > 0).join('\n');
  if (combinedText.trim().startsWith('/')) return;

  const first = buffer.items[0];
  if (!first) return;

  const combinedAttachments: N8nAttachment[] = [];
  for (const item of buffer.items) {
    for (const att of item.attachments) combinedAttachments.push(att);
  }

  const gateway = await applyReplyGateway({
    senderNumber: first.senderNumber,
    isGroup: first.isGroup,
    messageText: combinedText || first.text,
    attachments: combinedAttachments,
    initialShouldReply: first.shouldReply,
  });

  const mentionedSet = new Set<string>();
  for (const item of buffer.items) {
    for (const jid of item.mentionedJids) mentionedSet.add(jid);
  }
  const combinedMentionedJids = Array.from(mentionedSet);

  const currentSock = sock;
  const deps = activeDeps;
  if (!currentSock || !deps) return;

  await handleMessage({
    sock: currentSock,
    msg: first.msg,
    remoteJid: first.remoteJid,
    messageContent: combinedText || first.text,
    attachments: combinedAttachments,
    messageType: first.messageType,
    mentionedJids: combinedMentionedJids,
    quotedMessage: first.quotedMessage,
    shouldReply: gateway.shouldReply,
    deps,
  });
}

export function getSocket(): WASocket | undefined {
  return sock;
}

export async function checkRegisteredNumber(jid: string): Promise<boolean> {
  if (!sock) {
    console.error('WhatsApp socket is not initialized.');
    return false;
  }
  try {
    const result = await sock.onWhatsApp(jid);
    const first = result?.[0];
    return Boolean(first?.exists);
  } catch (error) {
    console.error('Error checking registered number:', error);
    return false;
  }
}

type CommandHelpEntry = {
  usage: string;
  description: string;
  details?: string;
  available?: string;
  examples?: string[];
};

const HELP_COMMANDS_TEXT =
  `*Available Commands:*\n`
  + `*User Commands:*\n`
  + `- /finduser\n`
  + `- /resetpassword\n`
  + `- /unlock\n`
  + `- /newuser\n`
  + `\n*WiFi Commands:*\n`
  + `- /addwifi\n`
  + `- /checkwifi\n`
  + `- /movewifi\n`
  + `- /pools\n`
  + `- /leasereport\n`
  + `\n*System Commands:*\n`
  + `- /getups\n`
  + `- /getasset\n`
  + `- /getbitlocker\n`
  + `- /getlaps\n`
  + `- /getlapsdiag\n`
  + `- /setlaps\n`
  + `\n*License Commands:*\n`
  + `- /licenses\n`
  + `- /getlicense\n`
  + `- /expiring\n`
  + `- /licensereport\n`
  + `\n*Helpdesk Commands:*\n`
  + `- /ticketreport\n`
  + `\n*Alert Commands:*\n`
  + `- /ack\n`
  + `\n*To get detailed help for a specific command, use:*\n`
  + `- /help <command>\n\n`
  + `*Example:*\n`
  + `- /help finduser`;

const COMMAND_HELP: Record<string, CommandHelpEntry> = {
  finduser: {
    usage: '/finduser <name> [/photo]',
    description: 'Finds users in Active Directory by display name (CN).',
    details:
      'Searches by partial match on common name (CN). Returns display name, email, title, department, phone, and password info. Add `/photo` to include the user photo if available in AD.',
    examples: ['/finduser peggy', '/finduser "john doe"', '/finduser peggy /photo'],
  },
  resetpassword: {
    usage: '/resetpassword <username> <new_password> [/change]',
    description:
      'Resets the password for the given username. Optionally, use the `/change` flag to require the user to change their password at the next logon.',
    examples: ['/resetpassword johndoe newpassword123', '/resetpassword johndoe newpassword123 /change'],
  },
  unlock: {
    usage: '/unlock <username>',
    description: 'Unlocks an Active Directory user account (clears lockout).',
    examples: ['/unlock johndoe', '/unlock john.doe'],
  },
  getups: {
    usage: '/getups <ups_id>',
    description: 'Gets the details of the UPS with the given ID.',
    available: 'Available UPS Identifiers: pyr (Pyrite), mkt (Makarti)',
    examples: ['/getups pyr', '/getups mkt'],
  },
  getasset: {
    usage: '/getasset [type]',
    description: 'Summarizes assets from Snipe-IT by category.',
    available: `Types: ${Object.keys(CATEGORY_MAPPING).sort().join(', ')}`,
    examples: ['/getasset', '/getasset pc', '/getasset notebook', '/getasset monitor'],
  },
  addwifi: {
    usage: '/addwifi <pool> <mac> <comment> [/days <number_of_days>]',
    description:
      'Adds a WiFi user with the given MAC address and comment. Optionally, specify the number of days until expiration.',
    examples: [
      '/addwifi /staff 00:1A:2B:3C:4D:5E John Doe - Staff Member',
      '/addwifi /staff 00:1A:2B:3C:4D:5E /days 7 John Doe - Temporary Staff',
    ],
  },
  checkwifi: {
    usage: '/checkwifi <mac>',
    description: 'Checks the status of the WiFi user with the given MAC address.',
  },
  movewifi: {
    usage: '/movewifi <old_pool> <new_pool> <mac>',
    description: 'Moves the WiFi user with the given MAC address from the old pool to the new pool.',
  },
  newuser: {
    usage: '/newuser <username> <email>',
    description: 'Creates a new user with the given username and email.',
  },
  pools: {
    usage: '/pools',
    description:
      'Lists all available pools.\n- * /staff*, * /nonstaff*, and * /management*: mobile phones (WiFi MTI-02).\n- * /employeefull* and * /employeelimited*: laptops (WiFi MTI-01).\n- * /contractor*: laptops (WiFi MTI-03).',
  },
  leasereport: {
    usage: '/leasereport',
    description: 'Displays all users with a limited expiration date.',
  },
  getbitlocker: {
    usage: '/getbitlocker <hostname>',
    description: 'Retrieves BitLocker recovery keys for the specified hostname from Active Directory.',
    examples: ['/getbitlocker mti-nb-123'],
  },
  getlaps: {
    usage: '/getlaps <hostname>',
    description: 'Retrieves LAPS local admin account and current password for the specified hostname.',
    details:
      'For security, use this in private chat. Access is granted to LAPS admins (LAPS_ADMIN_PHONE_NUMBERS) and technicians with laps_access=true in technician contacts.',
    examples: ['/getlaps mti-nb-123'],
  },
  getlapsdiag: {
    usage: '/getlapsdiag <hostname>',
    description: 'Shows which LAPS LDAP attributes are visible to the bot account for a hostname.',
    details:
      'Diagnostic command only. Does not return passwords. Access is granted to LAPS admins (LAPS_ADMIN_PHONE_NUMBERS) and technicians with laps_access=true in technician contacts.',
    examples: ['/getlapsdiag mti-nb-123'],
  },
  setlaps: {
    usage: '/setlaps technician <id> /a|/d',
    description: 'Grants or revokes LAPS access for a technician.',
    details:
      'Admin-only. Updates technician contacts laps_access flag. Use /a to allow and /d to deny. Prefer running in private chat.',
    examples: ['/setlaps technician 7 /a', '/setlaps technician 7 /d'],
  },
  ticketreport: {
    usage: '/ticketreport [days] [technicianName]',
    description:
      'Generates a report of tickets created in the last specified number of days. Optionally, filter the report by technician name.',
    available: 'If no days are specified, defaults to the last 7 days.',
    examples: ['/ticketreport', '/ticketreport 14', '/ticketreport 30 peggy'],
  },
  technician: {
    usage: '/technician <command> [parameters]',
    description:
      "Comprehensive technician contact management system for IT support operations. Manage your team's contact information with full CRUD capabilities.",
    available:
      '📋 **Available Commands:**\n• **list** - Display all technicians\n• **search <query>** - Find technicians by name, phone, email, or role\n• **view <id>** - Show detailed info for specific technician\n• **add** - Add new technician with full details\n• **update** - Modify existing technician information\n• **delete** - Remove technician from database\n• **mapleave** - Auto-map leave_schedule_name from leave schedule file',
    examples: [
      '📋 **List all technicians:**\n/technician list',
      '🔍 **Search for specific technician:**\n/technician search Peggy\n/technician search "IT Support"\n/technician search 08123',
      '👤 **View technician details:**\n/technician view 5',
      '➕ **Add new technician:**\n/technician add "Ahmad Rizki" "Ahmad Rizki (Network Admin)" "08123456789" "ahmad.rizki@company.com" "Network Administrator" "Male"',
      '✏️ **Update technician info:**\n/technician update 3 "phone" "08987654321"\n/technician update 7 "email" "new.email@company.com"\n/technician update 2 "technician" "Senior IT Support"',
      '🗑️ **Remove technician:**\n/technician delete 8',
      '🧭 **Auto-map leave schedule names:**\n/technician mapleave\n/technician /mapleave',
    ],
    details:
      '**Real-world Usage Scenarios:**\n\n🔧 **Daily Operations:**\n• Quickly find technician contact during emergencies\n• Update phone numbers when staff get new devices\n• Add new team members with complete contact info\n• Search by role to find specialists (e.g., "Network", "Security")\n• Fill leave schedule mapping in bulk for dispatcher readiness\n\n📱 **Search Tips:**\n• Search by partial name: "Peg" finds "Peggy"\n• Search by role: "IT Support" finds all support staff\n• Search by phone: "0812" finds numbers starting with 0812\n• Search is case-insensitive and matches partial text\n\n⚠️ **Important Notes:**\n• Use quotes for multi-word values: "John Doe"\n• Available fields for update: name, ict_name, leave_schedule_name, phone, email, technician, gender\n• Each technician has a unique ID for precise operations\n• Changes are saved immediately to the database',
  },
  licenses: {
    usage: '/licenses [limit] [offset]',
    description: 'Lists all software licenses with pagination support.',
    details:
      'Retrieves licenses from Snipe-IT asset management system. Default limit is 50 licenses per page. Use offset for pagination.',
    examples: ['/licenses', '/licenses 10', '/licenses 10 0'],
  },
  getlicense: {
    usage: '/getlicense <name_or_id>',
    description: 'Gets detailed information about a specific license by name or ID.',
    details:
      'Searches for licenses by exact name match or ID. Returns details including manufacturer, purchase information, seat allocation, and expiration dates.',
    examples: ['/getlicense Microsoft Office', '/getlicense 123', '/getlicense "Adobe Creative Suite"'],
  },
  expiring: {
    usage: '/expiring [days]',
    description: 'Lists licenses expiring within specified number of days (default: 30).',
    details:
      'Shows license name, usage, total seats, and days until expiration. Useful for proactive renewals.',
    examples: ['/expiring', '/expiring 30', '/expiring 90'],
  },
  licensereport: {
    usage: '/licensereport',
    description: 'Generates a comprehensive license utilization report with statistics.',
    details:
      'Provides overview of total licenses, utilization rates, expiration status, and category breakdown.',
    examples: ['/licensereport'],
  },
  ack: {
    usage: '/ack [alert_id] or reply to alert message with /ack',
    description:
      'Acknowledges a Veeam alert. Can be used by replying to an alert message or providing the alert ID directly.',
    examples: ['/ack db95c987-a404-45b0-ba2c-c406f483e5b9'],
  },
};

function renderCommandHelp(commandKey: string): string | undefined {
  const details = COMMAND_HELP[commandKey];
  if (!details) return undefined;

  let helpText = `*Usage:* ${details.usage}\n*Description:* ${details.description}`;
  if (details.details) helpText += `\n*Details:* ${details.details}`;
  if (details.available) helpText += `\n*Available:* ${details.available}`;
  if (details.examples && details.examples.length > 0) {
    helpText += `\n*Example(s):*\n${details.examples.join('\n')}`;
  }
  return helpText;
}

type StartWhatsAppDeps = {
  io: SocketIoServer;
  store: InMemoryStore;
  authInfoDir: string;
  n8nWebhookUrl?: string;
  n8nTimeoutMs: number;
  allowedPhoneNumbers: string[];
};

let activeDeps: StartWhatsAppDeps | null = null;

type ParsedIncomingMessage = {
  text: string;
  attachments: N8nAttachment[];
  messageType: 'text' | 'extended_text' | 'image' | 'video' | 'audio' | 'document' | 'unknown';
  mentionedJids: string[];
  quotedMessage: N8nQuotedMessage | null;
};

function isNotifyUpsertPayload(
  value: unknown
): value is { type: 'notify'; messages: proto.IWebMessageInfo[] } {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.type !== 'notify') return false;
  const messages = obj.messages;
  return Array.isArray(messages);
}

function splitCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (!ch) continue;

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function getRequesterPhoneFromMessage(msg: proto.IWebMessageInfo, remoteJid: string): string | undefined {
  const senderJid = remoteJid.endsWith('@g.us') ? msg.key?.participant : remoteJid;
  if (!senderJid) return undefined;
  const deps = activeDeps;
  const resolvedJid =
    deps && !remoteJid.endsWith('@g.us')
      ? resolveParticipantJid({ participant: senderJid, store: deps.store, authInfoDir: deps.authInfoDir })
      : senderJid;
  const digits = extractPhoneDigitsFromJid(resolvedJid);
  debugLapsAuth('requester_extract', {
    remoteJid,
    senderJid,
    resolvedJid,
    digits: digits ? maskPhoneForLogs(digits) : null,
  });
  return digits ?? undefined;
}

function extractParticipantRawFromUpsert(msg: proto.IWebMessageInfo): string | null {
  const viaKey = typeof msg.key?.participant === 'string' ? msg.key.participant : null;
  if (viaKey) return viaKey;

  const viaTopLevel =
    typeof (msg as unknown as { participant?: unknown }).participant === 'string'
      ? ((msg as unknown as { participant?: string }).participant ?? null)
      : null;
  return viaTopLevel;
}

function parseReactionGroupIds(): Set<string> {
  const raw = process.env.TICKET_REACTION_GROUP_IDS;
  if (!raw) return new Set();
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(parts);
}

function parsePhoneCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => normalizeTechnicianPhoneNumber(s))
    .filter((s) => s.length > 0);
}

function resolveLapsAdminPhones(allowedPhoneNumbers: string[]): string[] {
  const raw = process.env.LAPS_ADMIN_PHONE_NUMBERS;
  const fromEnv = parsePhoneCsv(raw);
  if (fromEnv.length > 0) {
    debugLapsAuth('resolve_admins', {
      source: 'LAPS_ADMIN_PHONE_NUMBERS',
      rawPresent: typeof raw === 'string' && raw.length > 0,
      rawLen: typeof raw === 'string' ? raw.length : 0,
      rawHasQuotes: typeof raw === 'string' ? raw.includes('"') || raw.includes("'") : false,
      count: fromEnv.length,
      sample: fromEnv.slice(0, 3).map((p) => maskPhoneForLogs(p)).join(','),
    });
    return fromEnv;
  }
  const fallback = allowedPhoneNumbers.map((n) => normalizeTechnicianPhoneNumber(n)).filter((n) => n.length > 0);
  debugLapsAuth('resolve_admins', {
    source: 'ALLOWED_PHONE_NUMBERS_fallback',
    rawPresent: typeof raw === 'string' && raw.length > 0,
    rawLen: typeof raw === 'string' ? raw.length : 0,
    rawHasQuotes: typeof raw === 'string' ? raw.includes('"') || raw.includes("'") : false,
    count: fallback.length,
    sample: fallback.slice(0, 3).map((p) => maskPhoneForLogs(p)).join(','),
  });
  return fallback;
}

function isLapsAdmin(requesterPhone: string, allowedPhoneNumbers: string[]): boolean {
  const normalized = normalizeTechnicianPhoneNumber(requesterPhone);
  if (!normalized) return false;
  const admins = resolveLapsAdminPhones(allowedPhoneNumbers);
  if (admins.length === 0) return false;
  const result = admins.includes(normalized);
  debugLapsAuth('is_admin', {
    requester: maskPhoneForLogs(normalized),
    result,
    adminsCount: admins.length,
  });
  return result;
}

function canUseLaps(requesterPhone: string, allowedPhoneNumbers: string[]): boolean {
  const normalized = normalizeTechnicianPhoneNumber(requesterPhone);
  if (!normalized) {
    debugLapsAuth('can_use_laps', { requesterRaw: requesterPhone, normalized: null, result: false, reason: 'normalize_failed' });
    return false;
  }
  const admin = isLapsAdmin(normalized, allowedPhoneNumbers);
  if (admin) {
    debugLapsAuth('can_use_laps', { requester: maskPhoneForLogs(normalized), result: true, reason: 'admin' });
    return true;
  }
  const contact = getContactByPhone(normalized);
  const hasAccess = contact?.laps_access === true;
  debugLapsAuth('can_use_laps', {
    requester: maskPhoneForLogs(normalized),
    result: hasAccess,
    reason: hasAccess ? 'technician_flag' : 'no_flag',
    contactFound: Boolean(contact),
  });
  return hasAccess;
}

function extractReactionTargetFromMessage(
  message: unknown
): { messageId: string; remoteJid?: string; text?: string | null } | null {
  if (!isRecordValue(message)) return null;

  const reactionMessage = message.reactionMessage;
  if (isRecordValue(reactionMessage)) {
    const key = reactionMessage.key;
    if (!isRecordValue(key)) return null;
    const messageId = typeof key.id === 'string' ? key.id : '';
    const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : undefined;
    const text =
      typeof reactionMessage.text === 'string'
        ? reactionMessage.text
        : reactionMessage.text === null
          ? null
          : undefined;
    if (!messageId) return null;
    return { messageId, remoteJid, text };
  }

  const ephemeral = message.ephemeralMessage;
  if (isRecordValue(ephemeral)) {
    const inner = ephemeral.message;
    return extractReactionTargetFromMessage(inner);
  }

  return null;
}

function isReactionRemoved(reactionText: string | null | undefined): boolean {
  return reactionText === '' || reactionText === null;
}

function isClosedStatusName(value: string | null | undefined): boolean {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!v) return false;
  const closedPrefixes = ['resolved', 'closed', 'cancelled', 'canceled'];
  return closedPrefixes.some((prefix) => v === prefix || v.startsWith(`${prefix} `) || v.startsWith(`${prefix}-`));
}

async function handleTicketReactionClaim(args: {
  sock: WASocket;
  deps: StartWhatsAppDeps;
  source: 'messages.reaction' | 'messages.upsert';
  remoteJid: string;
  messageId: string;
  participantRaw: string;
}): Promise<void> {
  const sockUserJid = args.sock.user?.id;
  const sockDigits = typeof sockUserJid === 'string' ? extractPhoneDigitsFromJid(sockUserJid) : null;
  if (typeof sockUserJid === 'string' && args.participantRaw === sockUserJid) return;

  const participantJid = resolveParticipantJid({
    participant: args.participantRaw,
    store: args.deps.store,
    authInfoDir: args.deps.authInfoDir,
  });
  if (typeof sockUserJid === 'string' && participantJid === sockUserJid) return;
  const digits = extractPhoneDigitsFromJid(participantJid);
  if (!digits) return;

  if (sockDigits && digits === sockDigits) return;

  logTicketReactionDebug({
    event: 'claim',
    source: args.source,
    remoteJid: args.remoteJid,
    messageId: args.messageId,
    participantRaw: args.participantRaw,
    participantResolved: participantJid,
    participantDigits: digits,
    sockUserJid: typeof sockUserJid === 'string' ? sockUserJid : undefined,
    sockDigits,
  });

  const reacterPhone = normalizeTechnicianPhoneNumber(digits);
  const tech = getContactByPhone(reacterPhone);
  const stored = await loadTicketNotification({ remoteJid: args.remoteJid, messageId: args.messageId });
  if (!stored) return;
  const ticketId = stored.ticketId;

  function renderClaimFailed(reason: string): string {
    return `*Ticket Claim Failed*\nTicket ID: ${ticketId}\nReason: ${reason}`;
  }

  function renderAlreadyClaimed(by: string): string {
    return `*Ticket Already Claimed*\nTicket ID: *${ticketId}*\nClaimed by: *${by}*`;
  }

  if (!tech) {
    await sendChannelText(args.remoteJid, renderClaimFailed(`Phone ${reacterPhone} is not registered as a technician.`));
    return;
  }

  if (stored.claimed) {
    const by = stored.claimedByName ?? stored.claimedByPhone ?? 'another technician';
    await sendChannelText(args.remoteJid, renderAlreadyClaimed(by));
    return;
  }

  const requestObj = await viewRequest(ticketId);
  const previousStatus = requestObj?.status?.name ?? null;
  if (isClosedStatusName(previousStatus)) {
    await sendChannelText(
      args.remoteJid,
      `*Ticket Already Closed*\nTicket ID: *${ticketId}*\nStatus: *${previousStatus}*\nAction: Claim ignored.`
    );
    return;
  }
  const previousIctTechnician = requestObj?.udf_fields?.udf_pick_601 ?? null;
  const previousTechnicianName = requestObj?.technician?.name ?? null;
  const previousGroupNameUnknown: unknown = (requestObj as unknown as { group?: { name?: unknown } }).group?.name;
  const previousGroupName = typeof previousGroupNameUnknown === 'string' ? previousGroupNameUnknown : null;

  const claim = await claimTicketNotification({
    remoteJid: args.remoteJid,
    messageId: args.messageId,
    claimantPhone: reacterPhone,
    claimantName: tech.name,
    previous: {
      status: previousStatus,
      ictTechnician: previousIctTechnician,
      technicianName: previousTechnicianName,
      groupName: previousGroupName,
    },
  });

  if (!claim.ok) {
    const reason =
      claim.reason === 'not_found'
        ? 'Ticket notification was not found.'
        : claim.reason === 'invalid_record'
          ? 'Ticket notification record is invalid.'
          : claim.detail ?? 'Ticket notification storage error.';
    await sendChannelText(args.remoteJid, renderClaimFailed(reason));
    return;
  }

  if (claim.wasClaimed) {
    const by = claim.record.claimedByName ?? claim.record.claimedByPhone ?? 'another technician';
    await sendChannelText(args.remoteJid, renderAlreadyClaimed(by));
    return;
  }

  const priorityName = requestObj?.priority?.name;
  const priority = typeof priorityName === 'string' && priorityName.trim().length > 0 ? priorityName : 'Low';

  const groupName = determineServiceDeskGroupByRole(tech.technician);

  const updateRes = await updateRequest(ticketId, {
    ictTechnician: tech.ict_name,
    groupName,
    technicianName: tech.technician,
    status: 'In Progress',
    priority,
  });

  if (!updateRes.success) {
    await sendChannelText(
      args.remoteJid,
      `*Ticket Claimed (Partial)*\n` +
        `Ticket ID: *${ticketId}*\n` +
        `Technician: *${tech.name}*\n` +
        `Update: Failed\n` +
        `Details: ${updateRes.message}`
    );
    return;
  }

  await sendChannelText(args.remoteJid, `✅ Ticket *${ticketId}* claimed.\nTechnician: *${tech.name}*\nStatus: *In Progress*`);
}

async function handleTicketReactionUnclaim(args: {
  sock: WASocket;
  deps: StartWhatsAppDeps;
  source: 'messages.reaction' | 'messages.upsert';
  remoteJid: string;
  messageId: string;
  participantRaw: string;
}): Promise<void> {
  const sockUserJid = args.sock.user?.id;
  const sockDigits = typeof sockUserJid === 'string' ? extractPhoneDigitsFromJid(sockUserJid) : null;
  if (typeof sockUserJid === 'string' && args.participantRaw === sockUserJid) return;

  const participantJid = resolveParticipantJid({
    participant: args.participantRaw,
    store: args.deps.store,
    authInfoDir: args.deps.authInfoDir,
  });
  if (typeof sockUserJid === 'string' && participantJid === sockUserJid) return;
  const digits = extractPhoneDigitsFromJid(participantJid);
  if (!digits) return;
  if (sockDigits && digits === sockDigits) return;

  logTicketReactionDebug({
    event: 'unclaim',
    source: args.source,
    remoteJid: args.remoteJid,
    messageId: args.messageId,
    participantRaw: args.participantRaw,
    participantResolved: participantJid,
    participantDigits: digits,
    sockUserJid: typeof sockUserJid === 'string' ? sockUserJid : undefined,
    sockDigits,
  });

  const reacterPhone = normalizeTechnicianPhoneNumber(digits);
  const stored = await loadTicketNotification({ remoteJid: args.remoteJid, messageId: args.messageId });
  if (!stored) return;
  if (!stored.claimed) return;
  if (stored.claimedByPhone && stored.claimedByPhone !== reacterPhone) return;

  const ticketId = stored.ticketId;

  const result = await unclaimTicketNotification({
    remoteJid: args.remoteJid,
    messageId: args.messageId,
    claimantPhone: reacterPhone,
  });

  if (!result.ok) return;
  if (!result.wasUnclaimed) return;

  const requestObj = await viewRequest(ticketId);
  const priorityName = requestObj?.priority?.name;
  const priority = typeof priorityName === 'string' && priorityName.trim().length > 0 ? priorityName : 'Low';

  const statusToRestore =
    typeof stored.previousStatus === 'string' && stored.previousStatus.trim().length > 0 ? stored.previousStatus : 'Open';

  const updateArgs: {
    status: string;
    priority: string;
    technicianName?: string | null;
    ictTechnician?: string;
    groupName?: string | null;
  } = { status: statusToRestore, priority };

  if (stored.previousTechnicianName !== undefined) {
    updateArgs.technicianName = stored.previousTechnicianName;
  } else {
    updateArgs.technicianName = null;
  }

  if (stored.previousGroupName !== undefined) {
    updateArgs.groupName = stored.previousGroupName;
  }

  if (typeof stored.previousIctTechnician === 'string' && stored.previousIctTechnician.trim().length > 0) {
    updateArgs.ictTechnician = stored.previousIctTechnician;
  }

  const updateRes = await updateRequest(ticketId, updateArgs);
  if (!updateRes.success) {
    await sendChannelText(
      args.remoteJid,
      `*Ticket Unclaimed (Partial)*\n` +
        `Ticket ID: *${ticketId}*\n` +
        `Removed by: *${stored.claimedByName ?? stored.claimedByPhone ?? reacterPhone}*\n` +
        `Revert: Failed\n` +
        `Details: ${updateRes.message}`
    );
    return;
  }

  const assignmentLabel =
    (typeof stored.previousTechnicianName === 'string' && stored.previousTechnicianName.trim().length > 0) ||
    (typeof stored.previousGroupName === 'string' && stored.previousGroupName.trim().length > 0)
      ? 'Restored'
      : 'Cleared';

  const by = stored.claimedByName ?? stored.claimedByPhone ?? reacterPhone;
  await sendChannelText(
    args.remoteJid,
    `*Ticket Unclaimed*\nTicket ID: *${ticketId}*\nRemoved by: *${by}*\nStatus: *${statusToRestore}*\nAssignment: ${assignmentLabel}`
  );
}

function resolveParticipantJid(args: { participant: string; store: InMemoryStore; authInfoDir: string }): string {
  const sender = args.participant;
  if (!sender.includes('@lid')) return sender;

  const contactId = args.store.contacts[sender]?.id;
  const mappedViaContacts = contactId ?? sender;
  if (!mappedViaContacts.includes('@lid')) return mappedViaContacts;

  const lidUser = sender.split('@')[0] ?? '';
  const mappingFile = path.join(args.authInfoDir, `lid-mapping-${lidUser}_reverse.json`);
  if (!existsSync(mappingFile)) return mappedViaContacts;

  try {
    const raw = readFileSync(mappingFile, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string' && parsed) {
      return `${parsed}@s.whatsapp.net`;
    }
  } catch {
    return mappedViaContacts;
  }

  return mappedViaContacts;
}

function extractPhoneDigitsFromJid(jid: string): string | null {
  const directMatch = jid.match(/(\d+)(?::\d+)?@([A-Za-z0-9.-]+)/);
  if (directMatch?.[1]) return directMatch[1];

  const atIndex = jid.indexOf('@');
  const localPart = atIndex >= 0 ? jid.slice(0, atIndex) : jid;
  const fallbackDigits = localPart.replace(/\D/g, '');
  return fallbackDigits.length > 0 ? fallbackDigits : null;
}

function unwrapEphemeralMessage(message: proto.IMessage | null | undefined): proto.IMessage | undefined {
  const inner = message?.ephemeralMessage?.message;
  return inner ?? (message ?? undefined);
}

function extractMentionedJids(message: proto.IMessage | undefined): string[] {
  const contexts = [
    message?.extendedTextMessage?.contextInfo,
    message?.imageMessage?.contextInfo,
    message?.videoMessage?.contextInfo,
    message?.audioMessage?.contextInfo,
    message?.documentMessage?.contextInfo,
  ];

  const out: string[] = [];
  for (const ctx of contexts) {
    const mentioned = ctx?.mentionedJid;
    if (!Array.isArray(mentioned)) continue;
    for (const item of mentioned) {
      if (typeof item === 'string' && item.length > 0) out.push(item);
    }
  }
  return Array.from(new Set(out));
}

function isTaggedInGroup(args: {
  sock: WASocket;
  deps: StartWhatsAppDeps;
  msg: proto.IWebMessageInfo;
  messageText: string;
}): boolean {
  const botJid = args.sock.user?.id;
  if (typeof botJid !== 'string' || botJid.length === 0) return false;

  const botDigits = extractPhoneDigitsFromJid(botJid);
  const botHandle = botJid.split('@')[0] ?? '';
  const botHandleBase = botHandle.split(':')[0] ?? botHandle;

  const text = args.messageText;
  const textMentioned =
    (botDigits ? text.includes(`@${botDigits}`) : false) ||
    (botHandleBase ? text.includes(`@${botHandleBase}`) : false) ||
    (botHandle ? text.includes(`@${botHandle}`) : false);

  const rawMessage = unwrapEphemeralMessage(args.msg.message);
  const mentionedJids = extractMentionedJids(rawMessage);
  const jidMentioned = mentionedJids.some((jid) => {
    const resolved = resolveParticipantJid({
      participant: jid,
      store: args.deps.store,
      authInfoDir: args.deps.authInfoDir,
    });
    if (resolved === botJid) return true;
    const digits = extractPhoneDigitsFromJid(resolved);
    if (botDigits && digits && botDigits === digits) return true;
    const base = (resolved.split('@')[0] ?? '').split(':')[0] ?? '';
    return base.length > 0 && base === botHandleBase;
  });

  return textMentioned || jidMentioned;
}

async function parseIncomingMessage(args: { sock: WASocket; msg: proto.IWebMessageInfo }): Promise<ParsedIncomingMessage> {
  if (!args.msg.key) return { text: '', attachments: [], messageType: 'unknown', mentionedJids: [], quotedMessage: null };
  const rawMessage = unwrapEphemeralMessage(args.msg.message);
  if (!rawMessage) return { text: '', attachments: [], messageType: 'unknown', mentionedJids: [], quotedMessage: null };

  const mentionedJids = extractMentionedJids(rawMessage);

  const contextInfo =
    rawMessage.extendedTextMessage?.contextInfo ??
    rawMessage.imageMessage?.contextInfo ??
    rawMessage.videoMessage?.contextInfo ??
    rawMessage.audioMessage?.contextInfo ??
    rawMessage.documentMessage?.contextInfo;

  async function parseQuotedMessage(): Promise<N8nQuotedMessage | null> {
    const quotedRaw = contextInfo?.quotedMessage;
    if (!quotedRaw) return null;

    const actualQuoted = unwrapEphemeralMessage(quotedRaw) ?? quotedRaw;

    async function downloadBufferFromMessage(message: proto.IMessage): Promise<Buffer | null> {
      try {
        const msgForDownload = { message } as unknown as WAMessage;
        const downloaded = await downloadMediaMessage(msgForDownload, 'buffer', {}, {
          logger: mediaLogger,
          reuploadRequest: args.sock.updateMediaMessage,
        });
        return await toBufferFromDownloadedMedia(downloaded);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Error downloading quoted media:', message);
        return null;
      }
    }

    let quotedText = '';
    let quotedType: N8nQuotedMessage['type'] = 'unknown';
    let quotedMediaInfo: N8nAttachment | null = null;

    if (actualQuoted.conversation) {
      quotedText = actualQuoted.conversation;
      quotedType = 'text';
    } else if (actualQuoted.extendedTextMessage?.text) {
      quotedText = actualQuoted.extendedTextMessage.text;
      quotedType = 'extended_text';
    } else if (actualQuoted.imageMessage) {
      quotedText = actualQuoted.imageMessage.caption || 'Image';
      quotedType = 'image';
      const buffer = await downloadBufferFromMessage({ imageMessage: actualQuoted.imageMessage });
      const dataBase64 = buffer ? buffer.toString('base64') : null;
      quotedMediaInfo = {
        type: 'image',
        caption: actualQuoted.imageMessage.caption ?? '',
        mimetype: actualQuoted.imageMessage.mimetype ?? 'image/jpeg',
        fileLength: Number(actualQuoted.imageMessage.fileLength ?? 0),
        fileName: null,
        seconds: null,
        width: Number(actualQuoted.imageMessage.width ?? 0) || null,
        height: Number(actualQuoted.imageMessage.height ?? 0) || null,
        ptt: null,
        dataBase64: null,
        imageData: dataBase64,
        error: buffer ? null : 'Failed to download quoted image',
      };
    } else if (actualQuoted.videoMessage) {
      quotedText = actualQuoted.videoMessage.caption || 'Video';
      quotedType = 'video';
      const buffer = await downloadBufferFromMessage({ videoMessage: actualQuoted.videoMessage });
      const mediaSendMode = readMediaSendMode();
      const maxBytes = readPositiveIntEnv('N8N_MEDIA_MAX_BYTES', 1_000_000);
      const uploadsDir = resolveUploadsDir();
      const publicBaseUrl = resolvePublicBaseUrl();
      const preferUrl = mediaSendMode === 'file_url' || (mediaSendMode === 'auto' && buffer ? buffer.length > maxBytes : false);
      const shouldSendAsUrl = preferUrl && Boolean(publicBaseUrl);
      if (preferUrl && !publicBaseUrl) {
        console.warn(
          '[media] quoted_video:url_unavailable',
          JSON.stringify({ reason: 'PUBLIC_BASE_URL not set', mediaSendMode, maxBytes, bufferBytes: buffer?.length ?? 0 })
        );
      }
      const mime = actualQuoted.videoMessage.mimetype ?? 'video/mp4';
      const ext = guessFileExtensionFromMime(mime, 'mp4');
      const fileName = `${Date.now()}_${randomUUID()}.${ext}`;
      const filePath = shouldSendAsUrl && buffer ? path.join(uploadsDir, fileName) : null;
      if (filePath && buffer) {
        mkdirSync(uploadsDir, { recursive: true });
        writeFileSync(filePath, buffer);
      }
      const fileUrl = filePath && publicBaseUrl ? buildUploadsFileUrl(publicBaseUrl, fileName) : null;
      const videoData = !shouldSendAsUrl && buffer ? buffer.toString('base64') : null;
      quotedMediaInfo = {
        type: 'video',
        caption: actualQuoted.videoMessage.caption ?? '',
        mimetype: mime,
        fileLength: Number(actualQuoted.videoMessage.fileLength ?? 0),
        fileName: null,
        seconds: Number(actualQuoted.videoMessage.seconds ?? 0) || 0,
        width: Number(actualQuoted.videoMessage.width ?? 0) || null,
        height: Number(actualQuoted.videoMessage.height ?? 0) || null,
        ptt: null,
        dataBase64: null,
        videoData,
        fileUrl,
        filePath,
        error: buffer ? null : 'Failed to download quoted video',
      };
    } else if (actualQuoted.audioMessage) {
      quotedText = actualQuoted.audioMessage.ptt ? 'Voice message' : 'Audio';
      quotedType = 'audio';
      const buffer = await downloadBufferFromMessage({ audioMessage: actualQuoted.audioMessage });
      const dataBase64 = buffer ? buffer.toString('base64') : null;
      quotedMediaInfo = {
        type: 'audio',
        caption: '',
        mimetype: actualQuoted.audioMessage.mimetype ?? 'audio/ogg',
        fileLength: Number(actualQuoted.audioMessage.fileLength ?? 0),
        fileName: null,
        seconds: Number(actualQuoted.audioMessage.seconds ?? 0) || 0,
        width: null,
        height: null,
        ptt: Boolean(actualQuoted.audioMessage.ptt),
        dataBase64: null,
        audioData: dataBase64,
        error: buffer ? null : 'Failed to download quoted audio',
      };
    } else if (actualQuoted.documentMessage) {
      quotedText = actualQuoted.documentMessage.caption || actualQuoted.documentMessage.fileName || 'Document';
      quotedType = 'document';
      quotedMediaInfo = {
        type: 'document',
        caption: actualQuoted.documentMessage.caption ?? '',
        mimetype: actualQuoted.documentMessage.mimetype ?? 'application/octet-stream',
        fileLength: Number(actualQuoted.documentMessage.fileLength ?? 0),
        fileName: actualQuoted.documentMessage.fileName ?? null,
        seconds: null,
        width: null,
        height: null,
        ptt: null,
        dataBase64: null,
        error: null,
      };
    }

    const participant = typeof contextInfo?.participant === 'string' && contextInfo.participant.length > 0 ? contextInfo.participant : 'Unknown';
    const messageId = typeof contextInfo?.stanzaId === 'string' && contextInfo.stanzaId.length > 0 ? contextInfo.stanzaId : null;

    return {
      type: quotedType,
      text: quotedText,
      participant,
      messageId,
      mediaInfo: quotedMediaInfo,
      raw: quotedRaw,
    };
  }

  const quotedMessage = await parseQuotedMessage();

  if (rawMessage.conversation) return { text: rawMessage.conversation, attachments: [], messageType: 'text', mentionedJids, quotedMessage };
  if (rawMessage.extendedTextMessage?.text)
    return { text: rawMessage.extendedTextMessage.text, attachments: [], messageType: 'extended_text', mentionedJids, quotedMessage };
  if (rawMessage.buttonsResponseMessage?.selectedButtonId) {
    return { text: rawMessage.buttonsResponseMessage.selectedButtonId, attachments: [], messageType: 'unknown', mentionedJids, quotedMessage };
  }
  if (rawMessage.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return {
      text: rawMessage.listResponseMessage.singleSelectReply.selectedRowId,
      attachments: [],
      messageType: 'unknown',
      mentionedJids,
      quotedMessage,
    };
  }
  if (rawMessage.templateButtonReplyMessage?.selectedId) {
    return { text: rawMessage.templateButtonReplyMessage.selectedId, attachments: [], messageType: 'unknown', mentionedJids, quotedMessage };
  }

  const msgForDownload: WAMessage = { ...args.msg, key: args.msg.key, message: rawMessage };

  async function downloadBuffer(): Promise<Buffer | null> {
    try {
      const downloaded = await downloadMediaMessage(msgForDownload, 'buffer', {}, {
        logger: mediaLogger,
        reuploadRequest: args.sock.updateMediaMessage,
      });
      return await toBufferFromDownloadedMedia(downloaded);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Error downloading media:', message);
      return null;
    }
  }

  if (rawMessage.imageMessage) {
    const buffer = await downloadBuffer();
    const dataBase64 = buffer ? buffer.toString('base64') : null;
    const caption = rawMessage.imageMessage.caption ?? '';
    const attachment: N8nAttachment = {
      type: 'image',
      caption,
      mimetype: rawMessage.imageMessage.mimetype ?? 'image/jpeg',
      fileLength: Number(rawMessage.imageMessage.fileLength ?? 0),
      fileName: null,
      seconds: null,
      width: Number(rawMessage.imageMessage.width ?? 0) || null,
      height: Number(rawMessage.imageMessage.height ?? 0) || null,
      ptt: null,
      dataBase64: null,
      imageData: dataBase64,
      error: buffer ? null : 'Failed to download image',
    };
    return { text: caption || 'Image message received', attachments: [attachment], messageType: 'image', mentionedJids, quotedMessage };
  }

  if (rawMessage.videoMessage) {
    const buffer = await downloadBuffer();
    const caption = rawMessage.videoMessage.caption ?? '';
    const mediaSendMode = readMediaSendMode();
    const maxBytes = readPositiveIntEnv('N8N_MEDIA_MAX_BYTES', 1_000_000);
    const uploadsDir = resolveUploadsDir();
    const publicBaseUrl = resolvePublicBaseUrl();
    const preferUrl = mediaSendMode === 'file_url' || (mediaSendMode === 'auto' && buffer ? buffer.length > maxBytes : false);
    const shouldSendAsUrl = preferUrl && Boolean(publicBaseUrl);
    if (preferUrl && !publicBaseUrl) {
      console.warn(
        '[media] video:url_unavailable',
        JSON.stringify({ reason: 'PUBLIC_BASE_URL not set', mediaSendMode, maxBytes, bufferBytes: buffer?.length ?? 0 })
      );
    }
    const mime = rawMessage.videoMessage.mimetype ?? 'video/mp4';
    const ext = guessFileExtensionFromMime(mime, 'mp4');
    const fileName = `${Date.now()}_${args.msg.key?.id ?? randomUUID()}.${ext}`;
    const filePath = shouldSendAsUrl && buffer ? path.join(uploadsDir, fileName) : null;
    if (filePath && buffer) {
      mkdirSync(uploadsDir, { recursive: true });
      writeFileSync(filePath, buffer);
    }
    const fileUrl = filePath && publicBaseUrl ? buildUploadsFileUrl(publicBaseUrl, fileName) : null;
    const videoData = !shouldSendAsUrl && buffer ? buffer.toString('base64') : null;
    const attachment: N8nAttachment = {
      type: 'video',
      caption,
      mimetype: mime,
      fileLength: Number(rawMessage.videoMessage.fileLength ?? 0),
      fileName: null,
      seconds: Number(rawMessage.videoMessage.seconds ?? 0) || 0,
      width: Number(rawMessage.videoMessage.width ?? 0) || null,
      height: Number(rawMessage.videoMessage.height ?? 0) || null,
      ptt: null,
      dataBase64: null,
      videoData,
      fileUrl,
      filePath,
      error: buffer ? null : 'Failed to download video',
    };
    return { text: caption || 'Video message received', attachments: [attachment], messageType: 'video', mentionedJids, quotedMessage };
  }

  if (rawMessage.audioMessage) {
    const buffer = await downloadBuffer();
    const dataBase64 = buffer ? buffer.toString('base64') : null;
    const isPtt = Boolean(rawMessage.audioMessage.ptt);
    const attachment: N8nAttachment = {
      type: 'audio',
      caption: '',
      mimetype: rawMessage.audioMessage.mimetype ?? 'audio/ogg',
      fileLength: Number(rawMessage.audioMessage.fileLength ?? 0),
      fileName: null,
      seconds: Number(rawMessage.audioMessage.seconds ?? 0) || 0,
      width: null,
      height: null,
      ptt: isPtt,
      dataBase64: null,
      audioData: dataBase64,
      error: buffer ? null : 'Failed to download audio',
    };
    return {
      text: isPtt ? 'Voice message received' : 'Audio message received',
      attachments: [attachment],
      messageType: 'audio',
      mentionedJids,
      quotedMessage,
    };
  }

  if (rawMessage.documentMessage) {
    const buffer = await downloadBuffer();
    const dataBase64 = buffer ? buffer.toString('base64') : null;
    const caption = rawMessage.documentMessage.caption ?? '';
    const attachment: N8nAttachment = {
      type: 'document',
      caption,
      mimetype: rawMessage.documentMessage.mimetype ?? 'application/octet-stream',
      fileLength: Number(rawMessage.documentMessage.fileLength ?? 0),
      fileName: rawMessage.documentMessage.fileName ?? null,
      seconds: null,
      width: null,
      height: null,
      ptt: null,
      dataBase64: null,
      documentData: dataBase64,
      error: buffer ? null : 'Failed to download document',
    };
    const fallbackText = attachment.fileName ? `Document: ${attachment.fileName}` : 'Document message received';
    return { text: caption || fallbackText, attachments: [attachment], messageType: 'document', mentionedJids, quotedMessage };
  }

  return { text: 'Media/Other', attachments: [], messageType: 'unknown', mentionedJids, quotedMessage };
}

function pickReactionSenderFromUpsertMessage(args: {
  msg: proto.IWebMessageInfo;
  currentSock: WASocket;
  deps: StartWhatsAppDeps;
}): string | null {
  const msg = args.msg;
  const viaKey = typeof msg.key?.participant === 'string' && msg.key.participant ? msg.key.participant : undefined;
  const viaTopLevel =
    typeof (msg as unknown as { participant?: unknown }).participant === 'string'
      ? ((msg as unknown as { participant?: string }).participant ?? undefined)
      : undefined;

  const sockUserJid = args.currentSock.user?.id;
  const sockDigits = typeof sockUserJid === 'string' ? extractPhoneDigitsFromJid(sockUserJid) : null;

  const candidates = [viaTopLevel, viaKey].filter((v): v is string => typeof v === 'string' && v.length > 0);
  for (const candidate of candidates) {
    if (typeof sockUserJid === 'string' && candidate === sockUserJid) continue;
    const resolved = resolveParticipantJid({
      participant: candidate,
      store: args.deps.store,
      authInfoDir: args.deps.authInfoDir,
    });
    if (typeof sockUserJid === 'string' && resolved === sockUserJid) continue;
    const digits = extractPhoneDigitsFromJid(resolved);
    if (sockDigits && digits && digits === sockDigits) continue;
    return candidate;
  }

  if (
    sockDigits &&
    candidates.some((c) => {
      const resolved = resolveParticipantJid({ participant: c, store: args.deps.store, authInfoDir: args.deps.authInfoDir });
      return extractPhoneDigitsFromJid(resolved) === sockDigits;
    })
  ) {
    return null;
  }

  return candidates[0] ?? null;
}

function determineServiceDeskGroupByRole(role: string): string {
  const r = role.toLowerCase();
  if (r.includes('document control')) return 'ICT Document Controller';
  if (r.includes('it field support')) return 'ICT Network and Infrastructure';
  if (r.includes('it support')) return 'ICT System and Support';
  return 'ICT System and Support';
}

function truncateText(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  if (maxLen <= 3) return value.slice(0, maxLen);
  return `${value.slice(0, maxLen - 3)}...`;
}

function formatTwoColumnRows(rows: Array<{ label: string; value: string }>): string {
  const maxLabel = rows.reduce((m, r) => Math.max(m, r.label.length), 0);
  return rows.map((r) => `${r.label.padEnd(maxLabel)}  ${r.value}`).join('\n');
}

function renderTechnicianDetails(c: TechnicianContact): string {
  const email = c.email ?? 'N/A';
  const gender = c.gender ?? 'N/A';
  const leaveScheduleName = c.leave_schedule_name ?? 'N/A';
  const lapsAccess = c.laps_access === true ? 'yes' : 'no';
  const rows = formatTwoColumnRows([
    { label: 'ID', value: String(c.id) },
    { label: 'Name', value: c.name },
    { label: 'ICT Name', value: c.ict_name },
    { label: 'Leave Schedule', value: leaveScheduleName },
    { label: 'Role', value: c.technician },
    { label: 'LAPS Access', value: lapsAccess },
    { label: 'Phone', value: c.phone },
    { label: 'Email', value: email },
    { label: 'Gender', value: gender },
  ]);
  return `\`\`\`\n${rows}\n\`\`\``;
}

function renderTechnicianTable(contacts: TechnicianContact[]): string {
  const rows = contacts.map((c) => ({
    id: String(c.id),
    name: truncateText(c.name, 28),
    role: truncateText(c.technician, 28),
    phone: truncateText(c.phone, 18),
    laps: c.laps_access === true ? 'yes' : 'no',
  }));

  const maxId = Math.max(2, ...rows.map((r) => r.id.length));
  const maxName = Math.max(4, ...rows.map((r) => r.name.length));
  const maxRole = Math.max(4, ...rows.map((r) => r.role.length));
  const maxPhone = Math.max(5, ...rows.map((r) => r.phone.length));
  const maxLaps = Math.max(4, ...rows.map((r) => r.laps.length));

  const header = `${'ID'.padEnd(maxId)}  ${'Name'.padEnd(maxName)}  ${'Role'.padEnd(maxRole)}  ${'Phone'.padEnd(maxPhone)}  ${'LAPS'.padEnd(maxLaps)}`;
  const lines = rows.map(
    (r) =>
      `${r.id.padEnd(maxId)}  ${r.name.padEnd(maxName)}  ${r.role.padEnd(maxRole)}  ${r.phone.padEnd(maxPhone)}  ${r.laps.padEnd(maxLaps)}`
  );

  return `\`\`\`\n${[header, ...lines].join('\n')}\n\`\`\``;
}

function isUpdateField(value: string): value is TechnicianContactUpdateField {
  return (
    value === 'name' ||
    value === 'ict_name' ||
    value === 'leave_schedule_name' ||
    value === 'phone' ||
    value === 'email' ||
    value === 'technician' ||
    value === 'gender' ||
    value === 'laps_access'
  );
}

type LeaveMappingMode = 'exact' | 'pattern' | 'fuzzy';

type LeaveMappingResolution = {
  matchedKey: string;
  mode: LeaveMappingMode;
};

type LeaveMappingItem = {
  id: number;
  ictName: string;
  value: string;
  mode: LeaveMappingMode;
};

function parseBoolean(input: string | undefined, defaultValue: boolean): boolean {
  if (!input) return defaultValue;
  const normalized = input.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return defaultValue;
}

function parseNumber(input: string | undefined, defaultValue: number): number {
  if (!input) return defaultValue;
  const value = Number(input);
  return Number.isFinite(value) ? value : defaultValue;
}

function resolveLeaveSchedulePathForMapping(): { xlsxPath: string; sheetName: string; tzOffsetHours: number; dateShiftDays: number; similarityThreshold: number } {
  const dataDir = process.env.DATA_DIR && process.env.DATA_DIR.trim().length > 0 ? process.env.DATA_DIR.trim() : path.resolve(process.cwd(), 'data');
  const xlsxPath =
    process.env.DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH && process.env.DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH.trim().length > 0
      ? process.env.DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH.trim()
      : path.join(dataDir, 'MTI - Leave Schedule (ICT Team).xlsx');
  const sheetName =
    process.env.DISPATCHER_LEAVE_SCHEDULE_SHEET && process.env.DISPATCHER_LEAVE_SCHEDULE_SHEET.trim().length > 0
      ? process.env.DISPATCHER_LEAVE_SCHEDULE_SHEET.trim()
      : 'Human Resource';
  const tzOffsetHours = Math.floor(parseNumber(process.env.DISPATCHER_LEAVE_SCHEDULE_TZ_OFFSET_HOURS, 8));
  const dateShiftDays = Math.floor(parseNumber(process.env.DISPATCHER_LEAVE_SCHEDULE_DATE_SHIFT_DAYS, 1));
  const similarityThreshold = Math.min(1, Math.max(0, parseNumber(process.env.DISPATCHER_LEAVE_SCHEDULE_SIM_THRESHOLD, 0.9)));
  return { xlsxPath, sheetName, tzOffsetHours, dateShiftDays, similarityThreshold };
}

function resolvePatternCandidate(args: {
  scheduleKeys: string[];
  sourceName: string;
}): string | null {
  const sourceKey = normalizeScheduleBaseName(args.sourceName);
  if (!sourceKey) return null;
  const tokens = sourceKey
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4);
  if (tokens.length === 0) return null;

  const matches: string[] = [];
  for (const key of args.scheduleKeys) {
    const keyTokens = key.split(/\s+/);
    const keySet = new Set(keyTokens);
    const ok = tokens.every((t) => {
      if (keySet.has(t)) return true;
      return keyTokens.some((kt) => isTokenLikelyTypoMatch(t, kt));
    });
    if (ok) matches.push(key);
  }

  if (matches.length !== 1) return null;
  return matches[0];
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev: number[] = new Array(b.length + 1);
  const curr: number[] = new Array(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }

  return prev[b.length];
}

function isTokenLikelyTypoMatch(sourceToken: string, candidateToken: string): boolean {
  if (sourceToken.length < 5 || candidateToken.length < 5) return false;
  if (Math.abs(sourceToken.length - candidateToken.length) > 1) return false;
  const distance = levenshteinDistance(sourceToken, candidateToken);
  return distance <= 1;
}

function resolveLeaveMappingForContact(args: {
  scheduleIndex: Map<string, { status: string | null; onsite: boolean }>;
  scheduleKeys: string[];
  sourceName: string;
  allowFuzzy: boolean;
  similarityThreshold: number;
}): LeaveMappingResolution | null {
  const sourceKey = normalizeScheduleBaseName(args.sourceName);
  if (!sourceKey) return null;
  if (args.scheduleIndex.has(sourceKey)) return { matchedKey: sourceKey, mode: 'exact' };

  const pattern = resolvePatternCandidate({ scheduleKeys: args.scheduleKeys, sourceName: args.sourceName });
  if (pattern) return { matchedKey: pattern, mode: 'pattern' };

  const fuzzy = resolveLeaveScheduleEntry({
    scheduleIndex: args.scheduleIndex,
    personName: args.sourceName,
    allowFuzzy: args.allowFuzzy,
    similarityThreshold: args.similarityThreshold,
  });
  if (!fuzzy) return null;
  return { matchedKey: fuzzy.matchedKey, mode: 'fuzzy' };
}

function autoMapLeaveScheduleNames(): {
  changed: LeaveMappingItem[];
  skippedExisting: number;
  unresolved: Array<{ id: number; ictName: string }>;
  dateIso: string;
  xlsxPath: string;
  sheetName: string;
} {
  const cfg = resolveLeaveSchedulePathForMapping();
  const dateIso = getTodayIsoDateForOffsetHours(cfg.tzOffsetHours);
  const scheduleIndex = buildLeaveScheduleIndexForDate({
    xlsxPath: cfg.xlsxPath,
    sheetName: cfg.sheetName,
    dateIsoYyyyMmDd: dateIso,
    dateHeaderRow1Based: 9,
    dataStartRow1Based: 10,
    dateShiftDays: cfg.dateShiftDays,
  });
  const scheduleKeys = Array.from(scheduleIndex.keys());
  const allowFuzzy = parseBoolean(process.env.DISPATCHER_LEAVE_SCHEDULE_FUZZY, true);
  const contacts = listTechnicianContacts();

  const nextContacts = contacts.slice();
  const changed: LeaveMappingItem[] = [];
  let skippedExisting = 0;
  const unresolved: Array<{ id: number; ictName: string }> = [];

  for (let i = 0; i < nextContacts.length; i += 1) {
    const contact = nextContacts[i];
    const existing = typeof contact.leave_schedule_name === 'string' ? contact.leave_schedule_name.trim() : '';
    if (existing.length > 0) {
      skippedExisting += 1;
      continue;
    }

    const sourceName = contact.ict_name || contact.name;
    const mapped = resolveLeaveMappingForContact({
      scheduleIndex,
      scheduleKeys,
      sourceName,
      allowFuzzy,
      similarityThreshold: cfg.similarityThreshold,
    });

    if (!mapped) {
      unresolved.push({ id: contact.id, ictName: contact.ict_name });
      continue;
    }

    nextContacts[i] = { ...contact, leave_schedule_name: mapped.matchedKey };
    changed.push({
      id: contact.id,
      ictName: contact.ict_name,
      value: mapped.matchedKey,
      mode: mapped.mode,
    });
  }

  if (changed.length > 0) saveTechnicianContacts(nextContacts);

  return {
    changed,
    skippedExisting,
    unresolved,
    dateIso,
    xlsxPath: cfg.xlsxPath,
    sheetName: cfg.sheetName,
  };
}

async function handleMessage(args: {
  sock: WASocket;
  msg: proto.IWebMessageInfo;
  remoteJid: string;
  messageContent: string;
  attachments: N8nAttachment[];
  messageType?: string;
  mentionedJids?: string[];
  quotedMessage?: N8nQuotedMessage | null;
  shouldReply?: boolean;
  deps: StartWhatsAppDeps;
}): Promise<void> {
  const { sock, msg, remoteJid, messageContent, attachments, deps } = args;
  const isGroup = remoteJid.endsWith('@g.us');
  const senderNumber = resolveSenderNumber({ msg, remoteJid, store: deps.store, authInfoDir: deps.authInfoDir });
  const senderDigits = extractPhoneDigitsFromJid(senderNumber);
  const pushName = msg.pushName ?? 'Unknown';
  const shouldReply = args.shouldReply !== false;
  if (isGroup) console.log(`Group Message from ${pushName} (${senderNumber}) in Group ${remoteJid}`);
  else console.log(`Private Message from ${pushName} (${senderNumber})`);
  console.log(`Content: ${messageContent}`);

  if (!deps.n8nWebhookUrl) return;

  const botJid = sock.user?.id;
  const botNumber = typeof botJid === 'string' && botJid.length > 0 ? botJid : null;

  const adUser = await resolveAdUser({ senderDigits, senderJid: senderNumber, pushName });

  const directMediaInfo = attachments[0] ? { ...attachments[0], isQuoted: false, source: 'direct' as const } : null;
  const quotedMediaInfo = args.quotedMessage?.mediaInfo
    ? {
        ...args.quotedMessage.mediaInfo,
        isQuoted: true,
        source: 'quoted' as const,
        quotedFrom: args.quotedMessage.participant,
        quotedMessageId: args.quotedMessage.messageId,
      }
    : null;
  const media = directMediaInfo ?? quotedMediaInfo;
  const hasAttachment = Boolean(media);
  const attachmentType = media?.type ?? null;

  const baseTimeoutMs = deps.n8nTimeoutMs;
  const mediaSendMode = readMediaSendMode();
  const videoHasInlineData = media?.type === 'video' && Boolean(media.videoData ?? media.dataBase64);
  const effectiveTimeoutMs = videoHasInlineData && mediaSendMode !== 'file_url' ? Math.max(baseTimeoutMs, 60_000) : baseTimeoutMs;

  type N8nArgs = Parameters<typeof handleN8nIntegration>[0];
  const basePayload: N8nArgs['payload'] = {
    message: messageContent,
    from: senderNumber,
    fromNumber: senderDigits ?? senderNumber,
    replyTo: remoteJid,
    pushName,
    isGroup,
    groupId: isGroup ? remoteJid : null,
    timestamp: new Date().toISOString(),
    messageId: msg.key?.id,
    attachments: attachments.length > 0 ? attachments : undefined,
    attachmentCount: attachments.length,
    hasAttachment,
    attachmentType,
    mediaInfo: directMediaInfo,
    media,
    messageType: args.messageType ?? null,
    mentionedJids: args.mentionedJids ?? [],
    quotedMessage: args.quotedMessage ?? null,
    botNumber,
    botLid: null,
    shouldReply,
    adUser,
    processingPhase: 'analysis',
  };

  const isVideo = (args.messageType ?? null) === 'video' || media?.type === 'video';
  if (shouldReply && isVideo) {
    const ackTimeoutMs = readPositiveIntEnv('N8N_VIDEO_ACK_TIMEOUT_MS', 8_000);
    const caption = messageContent.trim();
    const seconds = typeof media?.seconds === 'number' && media.seconds > 0 ? media.seconds : null;
    const defaultAckTextFromEnv = process.env.N8N_VIDEO_ACK_FALLBACK_TEXT;
    const defaultAckText =
      defaultAckTextFromEnv && defaultAckTextFromEnv.trim().length > 0
        ? defaultAckTextFromEnv
        : seconds
          ? `Video received (${seconds}s). Please wait while I analyze it.`
          : 'Video received. Please wait while I analyze it.';

    const ackInstructionLines: string[] = [
      'SYSTEM:',
      'The user just sent a VIDEO message. Video analysis will be processed in a follow-up request.',
      'TASK:',
      'Reply with a short acknowledgment telling the user you are analyzing the video and they should wait.',
      'Do not ask follow-up questions. Do not attempt to analyze the video yet.',
    ];
    if (caption.length > 0) {
      ackInstructionLines.push('USER_CAPTION_OR_MESSAGE:', caption);
    }
    if (seconds) {
      ackInstructionLines.push('VIDEO_DURATION_SECONDS:', String(seconds));
    }
    const ackMessage = ackInstructionLines.join('\n');

    const ackPayload: N8nArgs['payload'] = {
      ...basePayload,
      message: ackMessage,
      processingPhase: 'ack',
      attachments: undefined,
      attachmentCount: 0,
      hasAttachment: false,
      attachmentType: null,
      mediaInfo: null,
      media: null,
    };

    await handleN8nIntegration({
      sock,
      remoteJid,
      payload: ackPayload,
      config: { webhookUrl: deps.n8nWebhookUrl, timeoutMs: ackTimeoutMs },
      fallback: { kind: 'text', text: defaultAckText },
    });
  }

  await handleN8nIntegration({
    sock,
    remoteJid,
    payload: basePayload,
    config: { webhookUrl: deps.n8nWebhookUrl, timeoutMs: effectiveTimeoutMs },
  });
}

async function handleCommand(args: {
  sock: WASocket;
  msg: proto.IWebMessageInfo;
  remoteJid: string;
  messageContent: string;
  allowedPhoneNumbers: string[];
}): Promise<void> {
  const { sock, msg, remoteJid, messageContent, allowedPhoneNumbers } = args;
  if (!messageContent.startsWith('/')) return;
  const [command] = messageContent.trim().split(/\s+/);
  const replyText = async (text: string): Promise<void> => {
    await sendChannelText(remoteJid, text);
  };
  const replyImage = async (buffer: Buffer, caption: string): Promise<void> => {
    await sendChannelImage(remoteJid, buffer, caption);
  };

  switch (command?.toLowerCase()) {
    case '/unmute': {
      if (remoteJid.endsWith('@g.us')) {
        await replyText('Use /unmute in a private chat.');
        return;
      }

      const senderKey = getReplyGatewaySenderKey(remoteJid);
      const existed = replyMuteStateBySender.delete(senderKey);
      await replyText(existed ? 'Auto-replies enabled.' : 'Auto-replies already enabled.');
      return;
    }
    case '/hi':
      await replyText('Hello!');
      return;
    case '/finduser': {
      const parts = messageContent.trim().split(/\s+/).slice(1);

      const photoIdx = parts.findIndex((p) => p.toLowerCase() === '/photo');
      const includePhoto = photoIdx !== -1;
      if (includePhoto) parts.splice(photoIdx, 1);

      if (parts.length === 0) {
        await replyText('Error: No name provided with /finduser command');
        return;
      }

      const query = parts.join(' ');
      const result = await findUsersByCommonName({ query, includePhoto });
      if (!result.success) {
        await replyText(`Error finding user: ${result.error}`);
        return;
      }

      if (result.users.length === 0) {
        await replyText('User not found.');
        return;
      }

      for (const user of result.users) {
        const rendered = renderFindUserCaption({ user, includePhoto });
        if (includePhoto && rendered.hasPhoto && rendered.photoBuffer) {
          await replyImage(rendered.photoBuffer, rendered.caption);
        } else {
          await replyText(rendered.caption);
        }
      }
      return;
    }
    case '/help':
      {
        const parts = messageContent.trim().split(/\s+/);
        const requested = parts[1]?.toLowerCase();
        if (requested) {
          const normalized = requested.startsWith('/') ? requested.slice(1) : requested;
          const helpText = renderCommandHelp(normalized);
          if (helpText) {
            await replyText(helpText);
            return;
          }

          await replyText('*Unknown command.* Use /help to see the list of available commands.');
          return;
        }

        await replyText(HELP_COMMANDS_TEXT);
        return;
      }
    case '/resetpassword': {
      const parts = messageContent.split(/ |\u00A0|'/);
      const username = parts[1];
      const newPassword = parts[2];

      if (!username || !newPassword) {
        await replyText('❌ Usage: /resetpassword <username> <newPassword> [/change]\nExample: /resetpassword john.doe NewPass123 /change');
        return;
      }

      const changePasswordAtNextLogon = parts.length > 3 && parts[3] === '/change';
      const requester = getRequesterPhoneFromMessage(msg, remoteJid);
      if (!requester) {
        await replyText('Invalid phone number format.');
        return;
      }

      if (allowedPhoneNumbers.length > 0 && !allowedPhoneNumbers.includes(requester)) {
        await replyText('Access denied.');
        return;
      }

      const result = await resetPassword({
        upn: username,
        newPassword,
        changePasswordAtNextLogon,
      });

      if (!result.success) {
        await replyText(`Error resetting password for ${username}: ${result.error}`);
        return;
      }

      await replyText(`Password reset for ${username} successful`);
      return;
    }
    case '/unlock': {
      const parts = splitCommandLine(messageContent);
      const username = parts[1];

      if (!username) {
        await replyText('❌ Usage: /unlock <username>\nExample: /unlock john.doe');
        return;
      }

      const requester = getRequesterPhoneFromMessage(msg, remoteJid);
      if (!requester) {
        await replyText('Invalid phone number format.');
        return;
      }

      if (allowedPhoneNumbers.length > 0 && !allowedPhoneNumbers.includes(requester)) {
        await replyText('Access denied.');
        return;
      }

      const result = await unlockAccount({ upn: username });
      if (!result.success) {
        await replyText(`Error unlocking account for ${username}: ${result.error}`);
        return;
      }

      await replyText(`Account unlocked for ${username} successful`);
      return;
    }
    case '/getasset': {
      try {
        const reply = await buildGetAssetReply(messageContent);
        await replyText(reply);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await replyText(`Error getting assets: ${message}`);
      }
      return;
    }
    case '/getbitlocker': {
      const hostname = messageContent.trim().split(/\s+/)[1];

      if (!hostname) {
        await replyText('❌ Invalid command format. Usage: /getbitlocker <hostname>\n\nExample: /getbitlocker MTI-NB-177');
        return;
      }

      const result = await getBitLockerInfo({ hostname });
      if (!result.success) {
        await replyText(`*Error:* ${result.error}`);
        return;
      }

      const { hostname: host, keys } = result.data;
      const lines: string[] = ['*BitLocker Recovery Keys*', `*Hostname:* ${host.toUpperCase()}`, `*Found:* ${keys.length}`, ''];

      keys.forEach((k, idx) => {
        const match = k.partitionId.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
        let formattedDate = 'Unknown';
        if (match) {
          const [, y, mo, d, h, mi, s] = match;
          const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
          formattedDate = dt
            .toLocaleString('en-GB', {
            timeZone: 'Asia/Jakarta',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          })
            .replace(',', '');
        }

        const guid = (k.partitionId.split('{')[1] || '').replace('}', '');
        const passwordId = guid.trim() ? guid : 'Unknown';

        lines.push(`*Key ${idx + 1}*`);
        lines.push(`• *Password ID:* ${passwordId}`);
        lines.push(`• *Created:* ${formattedDate} WIB`);
        lines.push(`• *Recovery Key:* ${k.password}`);
        if (idx < keys.length - 1) lines.push('');
      });

      await replyText(lines.join('\n'));
      return;
    }
    case '/getlaps': {
      if (remoteJid.endsWith('@g.us')) {
        await replyText('Use /getlaps in a private chat only.');
        return;
      }

      const requester = getRequesterPhoneFromMessage(msg, remoteJid);
      if (!requester) {
        await replyText('Invalid phone number format.');
        return;
      }
      debugLapsAuth('getlaps_request', {
        requester: maskPhoneForLogs(requester),
        requesterNormalized: maskPhoneForLogs(normalizeTechnicianPhoneNumber(requester)),
        remoteJid,
        allowedPhonesCount: allowedPhoneNumbers.length,
      });

      const admins = resolveLapsAdminPhones(allowedPhoneNumbers);
      if (admins.length === 0) {
        debugLapsAuth('deny_getlaps', {
          requester: maskPhoneForLogs(requester),
          remoteJid,
          reason: 'no_admins_configured',
        });
        await replyText('Access denied. Configure LAPS_ADMIN_PHONE_NUMBERS (or ALLOWED_PHONE_NUMBERS) before using /getlaps.');
        return;
      }

      if (!canUseLaps(requester, allowedPhoneNumbers)) {
        debugLapsAuth('deny_getlaps', {
          requester: maskPhoneForLogs(requester),
          requesterNormalized: maskPhoneForLogs(normalizeTechnicianPhoneNumber(requester)),
          remoteJid,
          reason: 'not_allowed',
          adminsCount: admins.length,
          adminsSample: admins.slice(0, 3).map((p) => maskPhoneForLogs(p)).join(','),
        });
        await replyText('Access denied.');
        return;
      }

      const hostname = messageContent.trim().split(/\s+/)[1];
      if (!hostname) {
        await replyText('❌ Invalid command format. Usage: /getlaps <hostname>\n\nExample: /getlaps MTI-NB-177');
        return;
      }

      const result = await getLapsInfo({ hostname });
      if (!result.success) {
        await replyText(`âŒ ${result.error}`);
        return;
      }

      const data = result.data;
      const lines = [
        '*LAPS Credentials*',
        `*Hostname:* ${data.hostname.toUpperCase()}`,
        `*Account:* ${data.account ?? 'Administrator'}`,
        `*Password:* ${data.password}`,
        `*Source:* ${data.source}`,
        `*Expires:* ${data.expiration ?? 'Unknown'}`,
      ];
      await replyText(lines.join('\n'));
      return;
    }
    case '/getlapsdiag': {
      if (remoteJid.endsWith('@g.us')) {
        await replyText('Use /getlapsdiag in a private chat only.');
        return;
      }

      const requester = getRequesterPhoneFromMessage(msg, remoteJid);
      if (!requester) {
        await replyText('Invalid phone number format.');
        return;
      }

      const admins = resolveLapsAdminPhones(allowedPhoneNumbers);
      if (admins.length === 0) {
        debugLapsAuth('deny_getlapsdiag', {
          requester: maskPhoneForLogs(requester),
          remoteJid,
          reason: 'no_admins_configured',
        });
        await replyText('Access denied. Configure LAPS_ADMIN_PHONE_NUMBERS (or ALLOWED_PHONE_NUMBERS) before using /getlapsdiag.');
        return;
      }

      if (!canUseLaps(requester, allowedPhoneNumbers)) {
        debugLapsAuth('deny_getlapsdiag', { requester: maskPhoneForLogs(requester), remoteJid, reason: 'not_allowed' });
        await replyText('Access denied.');
        return;
      }

      const hostname = messageContent.trim().split(/\s+/)[1];
      if (!hostname) {
        await replyText('❌ Invalid command format. Usage: /getlapsdiag <hostname>\n\nExample: /getlapsdiag MTI-NB-177');
        return;
      }

      const result = await getLapsDiagnostics({ hostname });
      if (!result.success) {
        await replyText(`âŒ ${result.error}`);
        return;
      }

      const data = result.data;
      const lines = [
        '*LAPS LDAP Diagnostics*',
        `*Hostname:* ${data.hostname.toUpperCase()}`,
        `*DN:* ${data.distinguishedName}`,
        '',
        '*Visible Attributes:*',
        `• msLAPS-Password: ${data.visibleAttributes.msLapsPassword ? 'yes' : 'no'}`,
        `• msLAPS-EncryptedPassword: ${data.visibleAttributes.msLapsEncryptedPassword ? 'yes' : 'no'}`,
        `• msLAPS-PasswordExpirationTime: ${data.visibleAttributes.msLapsPasswordExpirationTime ? 'yes' : 'no'}`,
        `• ms-Mcs-AdmPwd: ${data.visibleAttributes.msMcsAdmPwd ? 'yes' : 'no'}`,
        `• ms-Mcs-AdmPwdExpirationTime: ${data.visibleAttributes.msMcsAdmPwdExpirationTime ? 'yes' : 'no'}`,
      ];
      await replyText(lines.join('\n'));
      return;
    }
    case '/setlaps': {
      if (remoteJid.endsWith('@g.us')) {
        await replyText('Use /setlaps in a private chat only.');
        return;
      }

      const requester = getRequesterPhoneFromMessage(msg, remoteJid);
      if (!requester) {
        await replyText('Invalid phone number format.');
        return;
      }

      const admins = resolveLapsAdminPhones(allowedPhoneNumbers);
      if (admins.length === 0) {
        debugLapsAuth('deny_setlaps', {
          requester: maskPhoneForLogs(requester),
          remoteJid,
          reason: 'no_admins_configured',
        });
        await replyText('Access denied. Configure LAPS_ADMIN_PHONE_NUMBERS (or ALLOWED_PHONE_NUMBERS) before using /setlaps.');
        return;
      }

      if (!isLapsAdmin(requester, allowedPhoneNumbers)) {
        debugLapsAuth('deny_setlaps', { requester: maskPhoneForLogs(requester), remoteJid, reason: 'not_admin' });
        await replyText('Access denied.');
        return;
      }

      const tokens = splitCommandLine(messageContent);
      const kind = tokens[1]?.toLowerCase();
      const idRaw = tokens[2];
      const actionRaw = tokens[3];

      if (kind !== 'technician' || !idRaw || !actionRaw) {
        await replyText('Usage: /setlaps technician <id> /a|/d\nExample: /setlaps technician 7 /a');
        return;
      }

      const id = Number(idRaw);
      if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
        await replyText('Invalid technician id. Use: /setlaps technician <id> /a|/d');
        return;
      }

      const action = actionRaw.replace(/^\/+/, '').trim().toLowerCase();
      const allow = action === 'a' || action === 'add';
      const deny = action === 'd' || action === 'del' || action === 'delete';
      if (!allow && !deny) {
        await replyText('Invalid action. Use /a (allow) or /d (deny).');
        return;
      }

      const updated = updateTechnicianContact(id, 'laps_access', allow ? 'true' : 'false');
      if (!updated) {
        await replyText(`Update failed for technician id ${id}.`);
        return;
      }

      await replyText(`LAPS access ${allow ? 'granted' : 'revoked'}.\n\n${renderTechnicianDetails(updated)}`);
      return;
    }
    case '/licenses': {
      const parts = messageContent.trim().split(/\s+/);
      const limitRaw = parts[1];
      const offsetRaw = parts[2];

      const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.max(1, Number(limitRaw)) : 20;
      const offset = offsetRaw && /^\d+$/.test(offsetRaw) ? Math.max(0, Number(offsetRaw)) : 0;
      if ((limitRaw && !/^\d+$/.test(limitRaw)) || (offsetRaw && !/^\d+$/.test(offsetRaw))) {
        await replyText('Usage: /licenses [limit] [offset]\nExample: /licenses 20 0');
        return;
      }

      const result = await getLicenses({ limit, offset });
      if (!result.success) {
        await replyText(`❌ Error fetching licenses: ${result.error}`);
        return;
      }

      if (result.licenses.length === 0) {
        await replyText('📄 No licenses found in Snipe-IT.');
        return;
      }

      const lines: string[] = [];
      lines.push(`*📋 Licenses* (${result.total} total, showing ${result.licenses.length})`);
      lines.push('');

      result.licenses.forEach((license, index) => {
        const name = license.name ?? 'Unnamed License';
        const category = license.categoryName ?? 'Uncategorized';
        const seats = Math.max(0, license.seats);
        const available = Math.max(0, license.freeSeats);
        const used = Math.max(0, seats - available);
        const expiration = license.expirationDateFormatted ?? 'No expiration';
        lines.push(`*${index + 1}. ${name}*`);
        lines.push(`   📂 Category: ${category}`);
        lines.push(`   💺 Seats: ${used}/${seats} used (${available} available)`);
        lines.push(`   📅 Expires: ${expiration}`);
        lines.push('');
      });
      lines.push('_Use /getlicense <name_or_id> for detailed information_');

      await replyText(lines.join('\n'));
      return;
    }
    case '/getlicense': {
      const identifier = messageContent.trim().split(/\s+/).slice(1).join(' ').trim();
      if (!identifier) {
        await replyText('❌ Usage: /getlicense <license_name_or_id>\n\nExample: /getlicense "Microsoft Office"');
        return;
      }

      const result = await getLicenseByName(identifier);
      if (!result.success) {
        const lines: string[] = [`❌ ${result.error}`];
        if (result.suggestions && result.suggestions.length > 0) {
          lines.push('', '*Suggestions:*', ...result.suggestions.map((name) => `• ${name}`));
        }
        await replyText(lines.join('\n'));
        return;
      }

      const license = result.license;
      const name = license.name ?? 'Unnamed License';
      const category = license.categoryName ?? 'Uncategorized';
      const manufacturer = license.manufacturerName ?? 'Unknown';
      const seats = Math.max(0, license.seats);
      const available = Math.max(0, license.freeSeats);
      const used = Math.max(0, seats - available);
      const expiration = license.expirationDateFormatted ?? 'No expiration';
      const notes = license.notes ?? 'No notes';
      const purchaseDate = license.purchaseDateFormatted ?? 'Unknown';
      const purchaseCost = license.purchaseCost ?? 'Unknown';

      const lines = [
        '*📄 License Details*',
        '',
        `*Name:* ${name}`,
        `*ID:* ${license.id}`,
        `*Category:* ${category}`,
        `*Manufacturer:* ${manufacturer}`,
        `*Seats:* ${used}/${seats} used (${available} available)`,
        `*Expiration:* ${expiration}`,
        `*Purchase Date:* ${purchaseDate}`,
        `*Purchase Cost:* ${purchaseCost}`,
        `*Notes:* ${notes}`,
      ];
      await replyText(lines.join('\n'));
      return;
    }
    case '/expiring': {
      const parts = messageContent.trim().split(/\s+/);
      const daysRaw = parts[1];
      if (daysRaw && !/^\d+$/.test(daysRaw)) {
        await replyText('Usage: /expiring [days]\nExample: /expiring 30');
        return;
      }
      const days = daysRaw ? Math.max(1, Number(daysRaw)) : 30;

      const result = await getExpiringLicenses(days);
      if (!result.success) {
        await replyText(`❌ Error fetching expiring licenses: ${result.error}`);
        return;
      }

      if (result.licenses.length === 0) {
        await replyText(`✅ No licenses expiring within ${days} days.`);
        return;
      }

      const lines: string[] = [`*⚠️ Licenses Expiring in ${days} Days* (${result.total} found)`, ''];
      result.licenses.forEach((license, index) => {
        const name = license.name ?? 'Unnamed License';
        const category = license.categoryName ?? 'Uncategorized';
        const expiration = license.expirationDateFormatted ?? 'Unknown';
        const seats = Math.max(0, license.seats);
        const available = Math.max(0, license.freeSeats);
        const used = Math.max(0, seats - available);

        let daysUntilExpiration = 'unknown';
        if (license.expirationDateIso) {
          const expirationDate = new Date(license.expirationDateIso);
          if (!Number.isNaN(expirationDate.getTime())) {
            const diff = Math.ceil((expirationDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            daysUntilExpiration = String(diff);
          }
        }

        lines.push(`*${index + 1}. ${name}*`);
        lines.push(`   📂 Category: ${category}`);
        lines.push(`   💺 Usage: ${used}/${seats} seats`);
        lines.push(`   📅 Expires: ${expiration} (${daysUntilExpiration} days)`);
        lines.push('');
      });

      await replyText(lines.join('\n'));
      return;
    }
    case '/licensereport': {
      const result = await getLicenseUtilization();
      if (!result.success) {
        await replyText(`❌ Error generating license report: ${result.error}`);
        return;
      }

      const data = result.data;
      const lines: string[] = [
        '*📊 License Utilization Report*',
        '',
        '*📈 Overview:*',
        `• Total Licenses: ${data.totalLicenses}`,
        '',
        '*💺 Utilization:*',
        `• Fully Utilized (100%): ${data.utilization.fullyUtilized}`,
        `• Partially Utilized (50-99%): ${data.utilization.partiallyUtilized}`,
        `• Under Utilized (1-49%): ${data.utilization.underUtilized}`,
        `• Not Utilized (0%): ${data.utilization.notUtilized}`,
        '',
        '*📅 Expiration Status:*',
        `• Expired: ${data.expiration.expired}`,
        `• Expiring Soon (30 days): ${data.expiration.expiringSoon}`,
        `• Valid: ${data.expiration.valid}`,
        `• No Expiration: ${data.expiration.noExpiration}`,
        '',
        '*📂 By Category:*',
      ];

      Object.entries(data.categories).forEach(([category, info]) => {
        const utilizationPercent = info.totalSeats > 0 ? Math.round((info.usedSeats / info.totalSeats) * 100) : 0;
        lines.push(`• ${category}: ${info.count} licenses, ${info.usedSeats}/${info.totalSeats} seats (${utilizationPercent}%)`);
      });

      lines.push('', `_Generated: ${new Date(result.generatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' })}_`);
      await replyText(lines.join('\n'));
      return;
    }
    case '/technician': {
      const requester = getRequesterPhoneFromMessage(msg, remoteJid);
      const canUseTechCmd =
        Boolean(requester) && (allowedPhoneNumbers.includes(requester ?? '') || isLapsAdmin(requester ?? '', allowedPhoneNumbers));
      if (!canUseTechCmd) {
        await replyText('Access denied.');
        return;
      }

      const tokens = splitCommandLine(messageContent);
      const subRaw = tokens[1]?.toLowerCase();
      const sub = subRaw ? subRaw.replace(/^\/+/, '') : undefined;
      if (!sub) {
        const helpText = renderCommandHelp('technician');
        await replyText(helpText ?? 'Usage: /technician <command>');
        return;
      }

      const canManageTechnicians = Boolean(requester) && isLapsAdmin(requester ?? '', allowedPhoneNumbers);
      if ((sub === 'add' || sub === 'update' || sub === 'delete' || sub === 'mapleave') && !canManageTechnicians) {
        await replyText('Access denied.');
        return;
      }

      if (sub === 'list') {
        const contacts = listTechnicianContacts();
        if (contacts.length === 0) {
          const contactsPath = getTechnicianContactsPath();
          await replyText(
            `No technicians found.\n\n` +
              `Storage: ${contactsPath}\n\n` +
              `Add one:\n` +
              `/technician add "Name" "ICT Name" "628xxxxxxxxxxx" "email@company.com" "Role" "Gender"`
          );
          return;
        }

        await replyText(`*Technicians* (${contacts.length})\n\n${renderTechnicianTable(contacts)}`);
        return;
      }

      if (sub === 'search') {
        const query = tokens.slice(2).join(' ').trim();
        if (!query) {
          await replyText('Usage: /technician search <query>');
          return;
        }

        const results = searchTechnicianContacts(query);
        if (results.length === 0) {
          await replyText('No technicians matched your query.');
          return;
        }

        await replyText(`*Technician Search Results*\nQuery: ${query}\nMatches: ${results.length}\n\n${renderTechnicianTable(results)}`);
        return;
      }

      if (sub === 'view') {
        const idRaw = tokens[2];
        const id = idRaw ? Number(idRaw) : NaN;
        if (!Number.isFinite(id)) {
          await replyText('Usage: /technician view <id>');
          return;
        }

        const contact = getTechnicianContactById(id);
        if (!contact) {
          await replyText(`Technician with id ${id} not found.`);
          return;
        }

        await replyText(`*Technician Details*\n\n${renderTechnicianDetails(contact)}`);
        return;
      }

      if (sub === 'add') {
        const name = tokens[2];
        const ictName = tokens[3];
        const phone = tokens[4];
        const emailRaw = tokens[5];
        const technician = tokens[6];
        const gender = tokens[7];

        if (!name || !ictName || !phone || !emailRaw || !technician) {
          await replyText('Usage: /technician add "Name" "ICT Name" "Phone" "Email" "Role" "Gender"');
          return;
        }

        const email = emailRaw.toLowerCase() === 'null' || emailRaw === '-' ? null : emailRaw;
        const created = addTechnicianContact({
          name,
          ict_name: ictName,
          phone,
          email,
          technician,
          gender: gender ? gender : null,
        });

        await replyText(`Technician added.\n\n${renderTechnicianDetails(created)}`);
        return;
      }

      if (sub === 'update') {
        const idRaw = tokens[2];
        const fieldRaw = tokens[3];
        const value = tokens.slice(4).join(' ').trim();
        const id = idRaw ? Number(idRaw) : NaN;

        if (!Number.isFinite(id) || !fieldRaw || !value || !isUpdateField(fieldRaw)) {
          await replyText(
            'Usage: /technician update <id> "field" "value" (fields: name, ict_name, leave_schedule_name, phone, email, technician, gender, laps_access)'
          );
          return;
        }

        const updated = updateTechnicianContact(id, fieldRaw, value);
        if (!updated) {
          await replyText(`Update failed for technician id ${id}.`);
          return;
        }

        await replyText(`Technician updated.\n\n${renderTechnicianDetails(updated)}`);
        return;
      }

      if (sub === 'delete') {
        const idRaw = tokens[2];
        const id = idRaw ? Number(idRaw) : NaN;
        if (!Number.isFinite(id)) {
          await replyText('Usage: /technician delete <id>');
          return;
        }

        const ok = deleteTechnicianContact(id);
        await replyText(ok ? `Technician id ${id} deleted.` : `Technician id ${id} not found.`);
        return;
      }

      if (sub === 'mapleave') {
        try {
          const result = autoMapLeaveScheduleNames();
          const lines: string[] = [];
          lines.push('*Leave mapping update completed*');
          lines.push(`Date: ${result.dateIso}`);
          lines.push(`Sheet: ${result.sheetName}`);
          lines.push(`File: ${result.xlsxPath}`);
          lines.push(`Updated: ${result.changed.length}`);
          lines.push(`Skipped existing mapping: ${result.skippedExisting}`);
          lines.push(`Unresolved: ${result.unresolved.length}`);
          const byMode = result.changed.reduce(
            (acc, item) => {
              acc[item.mode] += 1;
              return acc;
            },
            { exact: 0, pattern: 0, fuzzy: 0 }
          );
          lines.push(`Modes: exact=${byMode.exact}, pattern=${byMode.pattern}, fuzzy=${byMode.fuzzy}`);

          if (result.changed.length > 0) {
            lines.push('');
            lines.push('*Updated mappings:*');
            for (const row of result.changed.slice(0, 20)) {
              lines.push(`- [${row.id}] ${row.ictName} => ${row.value} (${row.mode})`);
            }
            if (result.changed.length > 20) {
              lines.push(`- ...and ${result.changed.length - 20} more`);
            }
          }

          if (result.unresolved.length > 0) {
            lines.push('');
            lines.push('*Unresolved:*');
            for (const row of result.unresolved.slice(0, 20)) {
              lines.push(`- [${row.id}] ${row.ictName}`);
            }
            if (result.unresolved.length > 20) {
              lines.push(`- ...and ${result.unresolved.length - 20} more`);
            }
          }

          await replyText(lines.join('\n'));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await replyText(`Map leave failed: ${message}`);
        }
        return;
      }

      const helpText = renderCommandHelp('technician');
      await replyText(helpText ?? 'Unknown technician command.');
      return;
    }
    default:
      return;
  }
}

export async function startWhatsApp(deps: StartWhatsAppDeps): Promise<void> {
  activeDeps = deps;
  messageBuffers.clear();
  presenceStatus.clear();
  const { state, saveCreds } = await useMultiFileAuthState(deps.authInfoDir);
  if (!state.creds.registered) {
    pairingCodeRequested = false;
    pairingRequestInFlight = false;
  }

  const versionFromEnv = parseWaVersionEnv(process.env.WA_VERSION);
  let waVersion: WaVersion | undefined = versionFromEnv ?? undefined;
  if (!waVersion) {
    try {
      const latest = await fetchLatestBaileysVersion();
      const v = latest?.version;
      if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number')) {
        waVersion = [v[0], v[1], v[2]];
      }
    } catch {
      waVersion = [2, 2413, 1];
    }
  }

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, fatalLogger),
    },
    version: waVersion,
    logger: fatalLogger,
    browser: Browsers.macOS('Desktop'),
  });

  const pairingPhone = readPairingPhone();
  if (pairingPhone && !sock.authState.creds.registered && !pairingCodeRequested && !pairingRequestInFlight) {
    pairingCodeRequested = true;
    pairingRequestInFlight = true;
    deps.io.emit('message', `Pairing code mode active for ${pairingPhone}. Do not scan QR for this session.`);
    void (async () => {
      try {
        await delayMs(800);
        const code = await withTimeout(sock.requestPairingCode(pairingPhone), 12_000);
        deps.io.emit('message', `Pairing code: ${code}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.io.emit('message', `Pairing code request failed: ${message}`);
        pairingCodeRequested = false;
      } finally {
        pairingRequestInFlight = false;
      }
    })();
  }

  deps.store.bind(sock.ev);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const connection = update.connection;
    const lastDisconnect = update.lastDisconnect;
    const qr = update.qr;

    if (qr) {
      if (pairingPhone && !sock?.authState.creds.registered) {
        console.log('QR Code received but ignored because pairing code mode is active');
        deps.io.emit('message', 'QR ignored because pairing code mode is active.');
      } else {
        console.log('QR Code received');
        const url = await qrcode.toDataURL(qr);
        deps.io.emit('qr', url);
        deps.io.emit('message', 'QR Code received, scan please!');
      }
    }

    if (connection === 'close') {
      const statusCodeUnknown: unknown = (lastDisconnect?.error as unknown as { output?: { statusCode?: unknown } })
        .output?.statusCode;
      const statusCode = typeof statusCodeUnknown === 'number' ? statusCodeUnknown : undefined;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
      if (shouldReconnect) {
        const maxAttempts = readPositiveIntEnv('WA_MAX_RECONNECT_ATTEMPTS', 20);
        if (!reconnectInFlight) reconnectAttempt += 1;
        if (reconnectAttempt > maxAttempts) {
          clearReconnectTimer();
          const stopMessage =
            statusCode === 428
              ? 'Disconnected (428). Re-auth may be required. Reconnect paused.'
              : `Disconnected repeatedly. Reconnect paused after ${maxAttempts} attempts.`;
          deps.io.emit('message', stopMessage);
          console.warn(stopMessage);
          return;
        }

        const delayMs = Math.min(30_000, Math.max(2_000, reconnectAttempt * 2_000));
        const reconnectMessage =
          statusCode === 428
            ? `Disconnected (428). Reconnecting in ${Math.ceil(delayMs / 1000)}s...`
            : `Disconnected, reconnecting in ${Math.ceil(delayMs / 1000)}s...`;
        deps.io.emit('message', reconnectMessage);

        if (!reconnectTimer && !reconnectInFlight) {
          reconnectTimer = setTimeout(() => {
            clearReconnectTimer();
            reconnectInFlight = true;
            void startWhatsApp(deps).finally(() => {
              reconnectInFlight = false;
            });
          }, delayMs);
        }
      }
      return;
    }

    if (connection === 'open') {
      reconnectAttempt = 0;
      reconnectInFlight = false;
      clearReconnectTimer();
      console.log('Opened connection');
      deps.io.emit('ready', 'WhatsApp is ready!');
      deps.io.emit('message', 'WhatsApp is ready!');

      const currentSock = sock;
      if (!currentSock) return;

      try {
        const adminJid = '6285712612218@s.whatsapp.net';
        await currentSock.sendMessage(adminJid, { text: 'WhatsApp API Connected Successfully!' });
        console.log(`Sent connection message to ${adminJid}`);

        console.log('Fetching groups...');
        const groups = await currentSock.groupFetchAllParticipating();
        console.log('Groups list:');
        for (const group of Object.values(groups)) {
          console.log(`ID: ${group.id} | Name: ${group.subject}`);
        }
      } catch (error) {
        console.error('Error in post-connection tasks:', error);
      }
    }
  });

  sock.ev.on('messages.upsert', async (payloadUnknown) => {
    if (!isNotifyUpsertPayload(payloadUnknown)) return;

    const currentSock = sock;
    if (!currentSock) return;

    const botJid = currentSock.user?.id;
    const botDigits = typeof botJid === 'string' ? extractPhoneDigitsFromJid(botJid) : null;

    const allowedReactionGroups = parseReactionGroupIds();

    for (const msg of payloadUnknown.messages) {
      if (msg.key?.fromMe) continue;
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid) continue;
      if (remoteJid === 'status@broadcast') continue;

      if (typeof botJid === 'string' && botJid.length > 0 && remoteJid === botJid) {
        console.log('[self-skip]', JSON.stringify({ reason: 'remoteJid_is_bot', remoteJid }));
        continue;
      }

      const senderNumber = resolveSenderNumber({ msg, remoteJid, store: deps.store, authInfoDir: deps.authInfoDir });
      const senderDigits = extractPhoneDigitsFromJid(senderNumber);
      if (botDigits && senderDigits === botDigits) {
        console.log(
          '[self-skip]',
          JSON.stringify({ reason: 'sender_is_bot', remoteJid, senderNumber, senderDigits })
        );
        continue;
      }

      const reactionTarget = extractReactionTargetFromMessage(msg.message);
      if (reactionTarget) {
        const participantRaw = extractParticipantRawFromUpsert(msg);
        const reactionText = reactionTarget.text ?? null;
        const event: TicketReactionDebugPayload['event'] = isReactionRemoved(reactionText) ? 'unclaim' : 'claim';

        if (allowedReactionGroups.size === 0) {
          logTicketReactionDebug({
            event,
            source: 'messages.upsert',
            remoteJid,
            messageId: reactionTarget.messageId,
            reactionText,
            participantRaw: participantRaw ?? undefined,
            ignoredReason: 'no_allowed_groups_configured',
          });
          continue;
        }

        if (!allowedReactionGroups.has(remoteJid)) {
          logTicketReactionDebug({
            event,
            source: 'messages.upsert',
            remoteJid,
            messageId: reactionTarget.messageId,
            reactionText,
            participantRaw: participantRaw ?? undefined,
            ignoredReason: 'group_not_allowed',
          });
          continue;
        }

        if (!participantRaw) {
          logTicketReactionDebug({
            event,
            source: 'messages.upsert',
            remoteJid,
            messageId: reactionTarget.messageId,
            reactionText,
            ignoredReason: 'missing_participant',
          });
          continue;
        }

        const eventKey = buildReactionEventKey({
          remoteJid,
          messageId: reactionTarget.messageId,
          participantRaw,
          reactionText,
        });
        if (!shouldProcessReactionEvent(eventKey)) {
          logTicketReactionDebug({
            event,
            source: 'messages.upsert',
            remoteJid,
            messageId: reactionTarget.messageId,
            reactionText,
            participantRaw,
            ignoredReason: 'dedupe_skip',
          });
          continue;
        }

        if (isReactionRemoved(reactionText)) {
          await handleTicketReactionUnclaim({
            sock: currentSock,
            deps,
            source: 'messages.upsert',
            remoteJid,
            messageId: reactionTarget.messageId,
            participantRaw,
          });
        } else {
          await handleTicketReactionClaim({
            sock: currentSock,
            deps,
            source: 'messages.upsert',
            remoteJid,
            messageId: reactionTarget.messageId,
            participantRaw,
          });
        }
        continue;
      }

      const parsed = await parseIncomingMessage({ sock: currentSock, msg });
      const messageContent = parsed.text;
      if (messageContent.startsWith('/')) {
        await handleCommand({
          sock: currentSock,
          msg,
          remoteJid,
          messageContent,
          allowedPhoneNumbers: deps.allowedPhoneNumbers,
        });
      } else {
        const isGroup = remoteJid.endsWith('@g.us');
        const shouldReply = !isGroup || isTaggedInGroup({ sock: currentSock, deps, msg, messageText: messageContent });
        const shouldLogOnly = !shouldReply && isGroup && process.env.LOG_UNTAGGED_GROUPS !== 'false';
        if (!shouldReply) {
          if (shouldLogOnly) {
            const pushName = msg.pushName ?? 'Unknown';
            console.log(`Group Message from ${pushName} (${senderNumber}) in Group ${remoteJid}`);
            console.log(`Content: ${messageContent}`);
          }
          continue;
        }

        const pushName = msg.pushName ?? 'Unknown';
        const buffered = addToMessageBuffer({
          msg,
          text: messageContent,
          attachments: parsed.attachments,
          remoteJid,
          senderNumber,
          pushName,
          isGroup,
          shouldReply,
          messageType: parsed.messageType,
          mentionedJids: parsed.mentionedJids,
          quotedMessage: parsed.quotedMessage,
        });

        if (buffered) continue;

        const gateway = await applyReplyGateway({
          senderNumber,
          isGroup,
          messageText: messageContent,
          attachments: parsed.attachments,
          initialShouldReply: shouldReply,
        });

        await handleMessage({
          sock: currentSock,
          msg,
          remoteJid,
          messageContent,
          attachments: parsed.attachments,
          messageType: parsed.messageType,
          mentionedJids: parsed.mentionedJids,
          quotedMessage: parsed.quotedMessage,
          shouldReply: gateway.shouldReply,
          deps,
        });
      }
    }
  });

  sock.ev.on('presence.update', async (payloadUnknown) => {
    if (!PRESENCE_BUFFER_ENABLED) return;
    const deps = activeDeps;
    if (!deps) return;
    const items = extractPresenceItems(payloadUnknown);
    if (items.length === 0) return;

    for (const item of items) {
      const resolvedParticipantJid = resolveParticipantJid({
        participant: item.participantJid,
        store: deps.store,
        authInfoDir: deps.authInfoDir,
      });

      const presenceKey = getBufferKey({ remoteJid: item.remoteJid, senderNumber: resolvedParticipantJid });
      const isTyping = isPresenceTyping(item.presence);
      presenceStatus.set(presenceKey, { isTyping, lastUpdateMs: Date.now() });

      const buffer = messageBuffers.get(presenceKey);
      if (!buffer) continue;
      buffer.isTyping = isTyping;

      if (isTyping) {
        scheduleFlush({ key: presenceKey, buffer, forceMaxTimeout: true });
      } else {
        if (buffer.typingTimer) clearTimeout(buffer.typingTimer);
        buffer.typingTimer = setTimeout(() => {
          void flushMessageBuffer(presenceKey);
        }, PRESENCE_BUFFER_STOP_DELAY_MS);
      }
    }
  });

  sock.ev.on('messages.reaction', async (payloadUnknown) => {
    const allowedGroups = parseReactionGroupIds();
    if (allowedGroups.size === 0) return;

    const items = Array.isArray(payloadUnknown) ? payloadUnknown : [payloadUnknown];

    const currentSock = sock;
    if (!currentSock) return;

    const sockUserJid = currentSock.user?.id;
    const sockDigits = typeof sockUserJid === 'string' ? extractPhoneDigitsFromJid(sockUserJid) : null;

    for (const itemUnknown of items) {
      if (!itemUnknown || typeof itemUnknown !== 'object') continue;
      const item = itemUnknown as {
        key?: { remoteJid?: unknown; id?: unknown; participant?: unknown };
        reaction?: { key?: { participant?: unknown }; text?: unknown };
      };

      const remoteJid = typeof item.key?.remoteJid === 'string' ? item.key.remoteJid : undefined;
      const messageId = typeof item.key?.id === 'string' ? item.key.id : undefined;
      if (!remoteJid || !messageId) continue;
      if (!allowedGroups.has(remoteJid)) {
        logTicketReactionDebug({
          event: 'claim',
          source: 'messages.reaction',
          remoteJid,
          messageId,
          ignoredReason: 'group_not_allowed',
        });
        continue;
      }

      const participantRaw =
        typeof item.key?.participant === 'string'
          ? item.key.participant
          : typeof item.reaction?.key?.participant === 'string'
            ? item.reaction.key.participant
            : undefined;
      if (!participantRaw) {
        logTicketReactionDebug({
          event: 'claim',
          source: 'messages.reaction',
          remoteJid,
          messageId,
          ignoredReason: 'missing_participant',
        });
        continue;
      }

      const reactionText =
        typeof item.reaction?.text === 'string' ? item.reaction.text : item.reaction?.text === null ? null : undefined;
      if (reactionText === undefined) {
        logTicketReactionDebug({
          event: 'claim',
          source: 'messages.reaction',
          remoteJid,
          messageId,
          participantRaw,
          ignoredReason: 'missing_reaction_text',
        });
        continue;
      }

      const eventKey = buildReactionEventKey({ remoteJid, messageId, participantRaw, reactionText });
      if (!shouldProcessReactionEvent(eventKey)) {
        logTicketReactionDebug({
          event: isReactionRemoved(reactionText) ? 'unclaim' : 'claim',
          source: 'messages.reaction',
          remoteJid,
          messageId,
          reactionText,
          participantRaw,
          ignoredReason: 'dedupe_skip',
        });
        continue;
      }

      const participantJid = resolveParticipantJid({
        participant: participantRaw,
        store: deps.store,
        authInfoDir: deps.authInfoDir,
      });
      const participantDigits = extractPhoneDigitsFromJid(participantJid);
      if (sockDigits && participantDigits && participantDigits === sockDigits) continue;

      if (isReactionRemoved(reactionText)) {
        await handleTicketReactionUnclaim({
          sock: currentSock,
          deps,
          source: 'messages.reaction',
          remoteJid,
          messageId,
          participantRaw,
        });
      } else {
        await handleTicketReactionClaim({
          sock: currentSock,
          deps,
          source: 'messages.reaction',
          remoteJid,
          messageId,
          participantRaw,
        });
      }
    }
  });
}
