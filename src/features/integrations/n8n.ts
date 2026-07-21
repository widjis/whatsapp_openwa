import type { InboundMessageEvent, PresenceUpdateEvent } from '../channel/eventNormalizer.js';
import type { MessagingService } from '../channel/messagingService.js';
import type { N8nAdUserLookup } from './ldap.js';
import type { LdapService } from './ldap.js';
import { getContactByPhone, type TechnicianContact } from './technicianContacts.js';

type SessionLike = {
  getCurrentSession(): Promise<{ phone?: string | null }>;
};

type QuotedMessageInfo = {
  type: 'text' | 'extended_text' | 'image' | 'video' | 'audio' | 'document' | 'unknown';
  text: string;
  participant: string;
  messageId: string | null;
  mediaInfo: null;
  raw: unknown;
};

type N8nPayload = {
  message: string;
  from: string;
  fromNumber?: string | null;
  replyTo?: string;
  pushName: string;
  isGroup: boolean;
  groupId: string | null;
  timestamp: string;
  messageId: string | null;
  messageType?: string | null;
  mentionedJids?: string[];
  quotedMessage?: QuotedMessageInfo | null;
  botNumber?: string | null;
  botLid?: string | null;
  shouldReply?: boolean;
  adUser?: N8nAdUserLookup | null;
  gender?: string | null;
  honorific?: 'Pak' | 'Bu' | null;
  technicianProfile?: {
    id: number;
    name: string;
    ictName: string;
    technician: string;
    email: string | null;
    gender: string | null;
  } | null;
  provider?: string;
  sessionId?: string | null;
};

type MessageBufferItem = {
  event: InboundMessageEvent;
  shouldReply: boolean;
  receivedAtMs: number;
};

type MessageBuffer = {
  items: MessageBufferItem[];
  timer: ReturnType<typeof setTimeout> | null;
};

type PresenceState = {
  isTyping: boolean;
  lastUpdateMs: number;
};

type N8nConfig = {
  enabled: boolean;
  webhookUrl?: string;
  apiKey?: string;
  timeoutMs: number;
  debug: boolean;
  fallbackText?: string;
};

type N8nIntegrationResult = {
  handled: boolean;
  replyText?: string;
};

function truncate(value: string, max = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

function extractDigits(value: string | null): string | null {
  if (!value) return null;
  const localPart = value.split('@')[0] ?? value;
  const digits = localPart.replace(/[^\d]/g, '');
  return digits || null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function readMentionedJidsFromRecord(record: Record<string, unknown>): string[] {
  const mentioned =
    asArray(record.mentionedJid) ??
    asArray(record.mentionedJids) ??
    asArray(record.mentions) ??
    asArray(asRecord(record.contextInfo)?.mentionedJid) ??
    asArray(asRecord(record.contextInfo)?.mentionedJids) ??
    asArray(asRecord(record.contextInfo)?.mentions);

  if (!mentioned) return [];
  return mentioned.filter((item) => typeof item === 'string' && item.trim().length > 0) as string[];
}

function extractMentionedJidsFromRaw(raw: unknown): string[] {
  const envelope = asRecord(raw);
  if (!envelope) return [];

  const payload =
    asRecord(envelope.payload) ??
    asRecord(envelope.data) ??
    asRecord(envelope.message) ??
    asRecord(envelope.eventData) ??
    envelope;

  const message = asRecord(payload.message) ?? null;
  const containers: Array<Record<string, unknown>> = [];
  for (const candidate of [payload, message]) {
    if (candidate) containers.push(candidate);
  }

  if (message) {
    for (const key of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage']) {
      const nested = asRecord(message[key]);
      if (nested) containers.push(nested);
    }
  }

  const merged = new Set<string>();
  for (const container of containers) {
    for (const jid of readMentionedJidsFromRecord(container)) {
      merged.add(jid);
    }
  }

  return Array.from(merged);
}

function isTaggedInGroup(args: { text: string; raw: unknown; botDigits: string | null }): boolean {
  if (!args.botDigits) return false;

  const normalizedText = args.text ?? '';
  if (normalizedText.includes(`@${args.botDigits}`)) return true;

  const mentionedJids = extractMentionedJidsFromRaw(args.raw);
  return mentionedJids.some((jid) => extractDigits(jid) === args.botDigits);
}

function extractReplyText(value: unknown): string | null {
  if (typeof value === 'string') return firstNonEmptyString(value);
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractReplyText(item);
      if (extracted) return extracted;
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) return null;

  const direct = firstNonEmptyString(record.output, record.reply, record.message, record.text, record.response);
  if (direct) return direct;

  for (const containerKey of ['json', 'data', 'result', 'body']) {
    const nested = extractReplyText(record[containerKey]);
    if (nested) return nested;
  }

  return null;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function resolveHonorificFromGender(gender: string | null | undefined): 'Pak' | 'Bu' | null {
  const normalized = gender?.trim().toLowerCase() ?? '';
  if (!normalized) return null;
  if (['male', 'm', 'man', 'pria', 'laki-laki', 'lakilaki'].includes(normalized)) return 'Pak';
  if (['female', 'f', 'woman', 'wanita', 'perempuan'].includes(normalized)) return 'Bu';
  return null;
}

function mapTechnicianProfile(contact: TechnicianContact | undefined): N8nPayload['technicianProfile'] {
  if (!contact) return null;
  return {
    id: contact.id,
    name: contact.name,
    ictName: contact.ict_name,
    technician: contact.technician,
    email: contact.email ?? null,
    gender: contact.gender ?? null,
  };
}

function getBufferKey(event: InboundMessageEvent): string {
  return `${event.chatId}|${event.senderPhone ?? event.senderId}`;
}

function inferQuotedType(record: Record<string, unknown>): QuotedMessageInfo['type'] {
  if (asRecord(record.extendedTextMessage)) return 'extended_text';
  if (asRecord(record.imageMessage)) return 'image';
  if (asRecord(record.videoMessage)) return 'video';
  if (asRecord(record.audioMessage)) return 'audio';
  if (asRecord(record.documentMessage)) return 'document';
  if (typeof record.conversation === 'string') return 'text';
  return 'unknown';
}

function extractQuotedMessage(raw: unknown): QuotedMessageInfo | null {
  const envelope = asRecord(raw);
  if (!envelope) return null;
  const payload =
    asRecord(envelope.payload) ??
    asRecord(envelope.data) ??
    asRecord(envelope.message) ??
    asRecord(envelope.eventData) ??
    envelope;
  const message = asRecord(payload.message);
  if (!message) return null;

  const containers = [
    asRecord(message.extendedTextMessage),
    asRecord(message.imageMessage),
    asRecord(message.videoMessage),
    asRecord(message.audioMessage),
    asRecord(message.documentMessage),
  ].filter((value): value is Record<string, unknown> => Boolean(value));

  for (const container of containers) {
    const contextInfo = asRecord(container.contextInfo);
    const quoted = asRecord(contextInfo?.quotedMessage);
    if (!quoted) continue;
    return {
      type: inferQuotedType(quoted),
      text:
        firstNonEmptyString(
          quoted.conversation,
          asRecord(quoted.extendedTextMessage)?.text,
          asRecord(quoted.imageMessage)?.caption,
          asRecord(quoted.videoMessage)?.caption,
          asRecord(quoted.documentMessage)?.caption
        ) ?? '',
      participant: firstNonEmptyString(contextInfo?.participant, contextInfo?.remoteJid) ?? '',
      messageId: firstNonEmptyString(contextInfo?.stanzaId, contextInfo?.messageId),
      mediaInfo: null,
      raw: quoted,
    };
  }

  return null;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return await response.text();
    }
  }
  return await response.text();
}

export class N8nIntegrationService {
  private resolvedBotDigits: string | null | undefined;
  private readonly recentMessageIds = new Map<string, number>();
  private readonly messageBuffers = new Map<string, MessageBuffer>();
  private readonly presenceStates = new Map<string, PresenceState>();
  private readonly adUserCache = new Map<string, { value: N8nAdUserLookup | null; expiresAtMs: number }>();

  constructor(
    private readonly messaging: MessagingService,
    private readonly config: N8nConfig,
    private readonly session?: SessionLike,
    private readonly ldap?: LdapService
  ) {}

  isEnabled(): boolean {
    return this.config.enabled && typeof this.config.webhookUrl === 'string' && this.config.webhookUrl.trim().length > 0;
  }

  private async resolveBotDigits(): Promise<string | null> {
    if (this.resolvedBotDigits !== undefined) return this.resolvedBotDigits;
    if (!this.session) {
      this.resolvedBotDigits = null;
      return null;
    }

    try {
      const current = await this.session.getCurrentSession();
      this.resolvedBotDigits = extractDigits(current.phone ?? null);
      return this.resolvedBotDigits;
    } catch {
      this.resolvedBotDigits = null;
      return null;
    }
  }

  private getDedupeTtlMs(): number {
    return readPositiveIntEnv('N8N_MESSAGE_DEDUPE_TTL_MS', 5 * 60_000);
  }

  private getBufferTimeoutMs(): number {
    return readPositiveIntEnv('N8N_MESSAGE_BUFFER_TIMEOUT_MS', 1500);
  }

  private isPresenceBufferEnabled(): boolean {
    return process.env.N8N_PRESENCE_BUFFER_ENABLED !== 'false';
  }

  private getPresenceBufferMaxTimeoutMs(): number {
    return readPositiveIntEnv('N8N_PRESENCE_BUFFER_MAX_TIMEOUT_MS', 6000);
  }

  private getPresenceBufferStopDelayMs(): number {
    return readPositiveIntEnv('N8N_PRESENCE_BUFFER_STOP_DELAY_MS', 1000);
  }

  private getPresenceTypingStaleMs(): number {
    return readPositiveIntEnv('N8N_PRESENCE_TYPING_STALE_MS', 15_000);
  }

  private isBufferEnabled(): boolean {
    return process.env.N8N_MESSAGE_BUFFER_ENABLED !== 'false';
  }

  private getAdUserCacheTtlMs(): number {
    return readPositiveIntEnv('ADUSER_CACHE_TTL_MS', 10 * 60_000);
  }

  private cleanupRecentMessageIds(now = Date.now()): void {
    const ttlMs = this.getDedupeTtlMs();
    for (const [key, expiresAtMs] of this.recentMessageIds.entries()) {
      if (expiresAtMs <= now - ttlMs) {
        this.recentMessageIds.delete(key);
      }
    }
  }

  private shouldSkipDuplicate(event: InboundMessageEvent): boolean {
    if (!event.messageId) return false;
    const now = Date.now();
    const key = `${event.chatId}|${event.messageId}`;
    const lastSeenAtMs = this.recentMessageIds.get(key);
    if (typeof lastSeenAtMs === 'number' && now - lastSeenAtMs < this.getDedupeTtlMs()) {
      console.log(
        '[n8n:dedupe_skip]',
        JSON.stringify({
          chatId: event.chatId,
          senderId: event.senderId,
          messageId: event.messageId,
          textPreview: truncate(event.text),
        })
      );
      return true;
    }
    this.recentMessageIds.set(key, now);
    if (this.recentMessageIds.size > 5000) {
      this.cleanupRecentMessageIds(now);
    }
    return false;
  }

  private getPresenceKey(args: { chatId: string; participantId: string; participantPhone: string | null }): string {
    return `${args.chatId}|${args.participantPhone ?? args.participantId}`;
  }

  private isPresenceTyping(presence: string): boolean {
    return presence === 'composing' || presence === 'recording' || presence === 'typing';
  }

  private resolvePushName(event: InboundMessageEvent): string {
    const direct = event.pushName?.trim();
    if (direct) return direct;

    const payload = asRecord(event.raw);
    const extracted =
      firstNonEmptyString(
        payload?.pushName,
        payload?.senderName,
        payload?.notifyName,
        asRecord(payload?.payload)?.pushName,
        asRecord(payload?.data)?.pushName
      ) ?? 'Unknown';
    return extracted;
  }

  private async resolveAdUser(event: InboundMessageEvent, pushName: string): Promise<N8nAdUserLookup | null> {
    if (!this.ldap) return null;

    const cacheKey = event.senderPhone ?? event.senderId;
    const cached = this.adUserCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAtMs > now) return cached.value;

    const value = await this.ldap.findAdUserByPhone({ phone: cacheKey, pushName });
    this.adUserCache.set(cacheKey, { value, expiresAtMs: now + this.getAdUserCacheTtlMs() });
    return value;
  }

  private async buildPayload(event: InboundMessageEvent, message: string): Promise<N8nPayload> {
    const pushName = this.resolvePushName(event);
    const botDigits = await this.resolveBotDigits();
    const botNumber = botDigits ? `${botDigits}@c.us` : null;
    const mentionedJids = Array.from(new Set([...(event.mentionedJids ?? []), ...extractMentionedJidsFromRaw(event.raw)]));
    const quotedMessage = extractQuotedMessage(event.raw);
    const adUser = await this.resolveAdUser(event, pushName);
    const technicianContact = event.senderPhone ? getContactByPhone(event.senderPhone) : undefined;
    const gender = technicianContact?.gender ?? null;
    const honorific = resolveHonorificFromGender(gender);

    return {
      message,
      from: event.senderId,
      fromNumber: event.senderPhone,
      replyTo: event.chatId,
      pushName,
      isGroup: event.isGroup,
      groupId: event.isGroup ? event.chatId : null,
      timestamp: event.occurredAt,
      messageId: event.messageId,
      messageType: event.messageType ?? 'text',
      mentionedJids,
      quotedMessage,
      botNumber,
      botLid: null,
      shouldReply: true,
      adUser,
      gender,
      honorific,
      technicianProfile: mapTechnicianProfile(technicianContact),
      provider: event.provider,
      sessionId: event.sessionId,
    };
  }

  private async dispatchPayload(event: InboundMessageEvent, payload: N8nPayload): Promise<N8nIntegrationResult> {
    const webhookUrl = this.config.webhookUrl?.trim() ?? '';
    if (!webhookUrl) return { handled: false };

    const startedAtMs = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1_000, this.config.timeoutMs));

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const responsePayload = await readResponsePayload(response);
      const latencyMs = Date.now() - startedAtMs;

      if (this.config.debug) {
        console.log(
          '[n8n:response]',
          JSON.stringify({
            ok: response.ok,
            status: response.status,
            latencyMs,
            chatId: event.chatId,
            senderId: event.senderId,
            messageId: event.messageId,
            pushName: payload.pushName,
            fromNumber: payload.fromNumber ?? null,
            textPreview: truncate(payload.message),
          })
        );
      }

      if (!response.ok) {
        const message =
          typeof responsePayload === 'string'
            ? responsePayload
            : JSON.stringify(responsePayload);
        throw new Error(`n8n ${response.status} ${response.statusText}: ${truncate(message, 240)}`);
      }

      const reply = extractReplyText(responsePayload);
      const finalReply = reply ?? this.config.fallbackText ?? null;
      if (!finalReply) return { handled: false };

      await this.messaging.sendText({ chatId: event.chatId, text: finalReply });
      return { handled: true, replyText: finalReply };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        '[n8n:error]',
        JSON.stringify({
          chatId: event.chatId,
          senderId: event.senderId,
          messageId: event.messageId,
          pushName: payload.pushName,
          fromNumber: payload.fromNumber ?? null,
          message,
        })
      );

      const fallback = this.config.fallbackText;
      if (fallback && fallback.trim().length > 0) {
        await this.messaging.sendText({ chatId: event.chatId, text: fallback });
        return { handled: true, replyText: fallback };
      }

      return { handled: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  private scheduleFlush(key: string, delayMs = this.getBufferTimeoutMs()): void {
    const buffer = this.messageBuffers.get(key);
    if (!buffer) return;
    if (buffer.timer) clearTimeout(buffer.timer);
    if (this.config.debug) {
      console.log('[n8n:buffer_schedule]', JSON.stringify({ key, count: buffer.items.length, timeoutMs: delayMs }));
    }
    buffer.timer = setTimeout(() => {
      void this.flushBuffer(key);
    }, delayMs);
  }

  private async flushBuffer(key: string): Promise<void> {
    const buffer = this.messageBuffers.get(key);
    if (!buffer || buffer.items.length === 0) return;

    if (buffer.timer) clearTimeout(buffer.timer);

    const first = buffer.items[0]?.event;
    if (!first) return;

    const presence = this.presenceStates.get(key);
    if (presence?.isTyping) {
      const ageMs = Date.now() - presence.lastUpdateMs;
      if (ageMs < this.getPresenceTypingStaleMs()) {
        if (this.config.debug) {
          console.log(
            '[n8n:buffer_hold_typing]',
            JSON.stringify({
              key,
              chatId: first.chatId,
              senderId: first.senderId,
              ageMs,
              staleMs: this.getPresenceTypingStaleMs(),
            })
          );
        }
        this.scheduleFlush(key, this.getPresenceBufferStopDelayMs());
        return;
      }

      if (this.config.debug) {
        console.log(
          '[n8n:presence_stale_release]',
          JSON.stringify({
            key,
            chatId: first.chatId,
            senderId: first.senderId,
            ageMs,
            staleMs: this.getPresenceTypingStaleMs(),
          })
        );
      }
      this.presenceStates.delete(key);
    }

    this.messageBuffers.delete(key);

    const combinedText = buffer.items
      .map((item) => item.event.text.trim())
      .filter((value) => value.length > 0)
      .join('\n');
    if (!combinedText || combinedText.startsWith('/')) return;

    if (this.config.debug) {
      console.log(
        '[n8n:buffer_flush]',
        JSON.stringify({
          key,
          count: buffer.items.length,
          chatId: first.chatId,
          senderId: first.senderId,
          messageIds: buffer.items.map((item) => item.event.messageId).filter(Boolean),
          textPreview: truncate(combinedText, 240),
        })
      );
    }

    const mergedMentionedJids = Array.from(
      new Set(buffer.items.flatMap((item) => item.event.mentionedJids ?? []))
    );
    const mergedEvent: InboundMessageEvent = {
      ...first,
      text: combinedText,
      mentionedJids: mergedMentionedJids,
    };
    const payload = await this.buildPayload(mergedEvent, combinedText);
    await this.dispatchPayload(mergedEvent, payload);
  }

  async processInboundMessage(event: InboundMessageEvent): Promise<N8nIntegrationResult> {
    if (!this.isEnabled()) return { handled: false };

    if (event.isGroup) {
      const botDigits = await this.resolveBotDigits();
      const shouldReply = isTaggedInGroup({ text: event.text, raw: event.raw, botDigits });
      if (!shouldReply) {
        if (process.env.LOG_UNTAGGED_GROUPS !== 'false') {
          console.log(
            '[n8n:skip_group]',
            JSON.stringify({
              chatId: event.chatId,
              senderId: event.senderId,
              messageId: event.messageId,
              textPreview: truncate(event.text),
            })
          );
        }
        return { handled: false };
      }
    }

    if (this.shouldSkipDuplicate(event)) {
      return { handled: true };
    }

    if (!this.isBufferEnabled()) {
      const payload = await this.buildPayload(event, event.text);
      return await this.dispatchPayload(event, payload);
    }

    const key = getBufferKey(event);
    const existing = this.messageBuffers.get(key);
    if (existing) {
      existing.items.push({ event, shouldReply: true, receivedAtMs: Date.now() });
    } else {
      this.messageBuffers.set(key, {
        items: [{ event, shouldReply: true, receivedAtMs: Date.now() }],
        timer: null,
      });
    }
    if (this.config.debug) {
      const count = this.messageBuffers.get(key)?.items.length ?? 0;
      console.log(
        '[n8n:buffer_add]',
        JSON.stringify({
          key,
          count,
          chatId: event.chatId,
          senderId: event.senderId,
          senderPhone: event.senderPhone,
          messageId: event.messageId,
          textPreview: truncate(event.text),
        })
      );
    }
    const presence = this.presenceStates.get(key);
    const delayMs = presence?.isTyping && this.isPresenceBufferEnabled() ? this.getPresenceBufferMaxTimeoutMs() : this.getBufferTimeoutMs();
    this.scheduleFlush(key, delayMs);
    return { handled: true };
  }

  async processPresenceUpdate(event: PresenceUpdateEvent): Promise<{ handled: boolean }> {
    if (!this.isEnabled()) return { handled: false };
    if (!this.isPresenceBufferEnabled()) return { handled: false };

    let handled = false;
    for (const update of event.updates) {
      const key = this.getPresenceKey({
        chatId: event.chatId,
        participantId: update.participantId,
        participantPhone: update.participantPhone,
      });
      const isTyping = this.isPresenceTyping(update.presence);
      this.presenceStates.set(key, { isTyping, lastUpdateMs: Date.now() });

      const buffer = this.messageBuffers.get(key);
      if (!buffer) continue;
      handled = true;

      const delayMs = isTyping ? this.getPresenceBufferMaxTimeoutMs() : this.getPresenceBufferStopDelayMs();
      if (this.config.debug) {
        console.log(
          '[n8n:presence_update]',
          JSON.stringify({
            key,
            chatId: event.chatId,
            participantId: update.participantId,
            participantPhone: update.participantPhone,
            presence: update.presence,
            isTyping,
            bufferCount: buffer.items.length,
            delayMs,
          })
        );
      }
      this.scheduleFlush(key, delayMs);
    }

    return { handled };
  }
}
