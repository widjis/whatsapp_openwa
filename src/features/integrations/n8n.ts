import type { InboundMessageEvent } from '../channel/eventNormalizer.js';
import type { MessagingService } from '../channel/messagingService.js';

type SessionLike = {
  getCurrentSession(): Promise<{ phone?: string | null }>;
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

  constructor(
    private readonly messaging: MessagingService,
    private readonly config: N8nConfig,
    private readonly session?: SessionLike
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

  async processInboundMessage(event: InboundMessageEvent): Promise<N8nIntegrationResult> {
    if (!this.isEnabled()) return { handled: false };

    const webhookUrl = this.config.webhookUrl?.trim() ?? '';
    if (!webhookUrl) return { handled: false };

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

    const payload = {
      message: event.text,
      from: event.senderId,
      fromNumber: event.senderPhone,
      replyTo: event.chatId,
      pushName: null,
      isGroup: event.isGroup,
      groupId: event.isGroup ? event.chatId : null,
      timestamp: event.occurredAt,
      messageId: event.messageId,
      messageType: 'text',
      provider: event.provider,
      sessionId: event.sessionId,
      shouldReply: true,
    };

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
            textPreview: truncate(event.text),
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
}
