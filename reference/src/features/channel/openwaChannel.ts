import type { ChannelGroupMetadata, ChannelGroupSummary, ChannelMessage, ChannelSendResult, ChannelService } from './types.js';
import { createOpenwaClient } from './openwaClient.js';

function normalizeDirectChatId(chatId: string): string {
  if (chatId.endsWith('@g.us') || chatId.endsWith('@c.us')) return chatId;
  if (chatId.endsWith('@s.whatsapp.net')) {
    const digits = chatId.split('@')[0]?.replace(/[^\d]/g, '') ?? '';
    return `${digits}@c.us`;
  }

  const digits = chatId.replace(/[^\d]/g, '');
  return digits ? `${digits}@c.us` : chatId;
}

function encodeBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

function readBooleanLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return null;
}

function extractMessageId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const keys = [record.messageId, record.id, record.msgId];
  for (const key of keys) {
    if (typeof key === 'string' && key.trim().length > 0) return key;
  }
  const data = record.data;
  if (data && typeof data === 'object') {
    const nested = extractMessageId(data);
    if (nested) return nested;
  }
  return undefined;
}

function parseCheckRegistered(payload: unknown): boolean {
  if (typeof payload === 'boolean') return payload;
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  const candidates = [record.exists, record.registered, record.onWhatsApp, record.valid];
  for (const candidate of candidates) {
    const parsed = readBooleanLike(candidate);
    if (parsed !== null) return parsed;
  }
  const data = record.data;
  if (data && typeof data === 'object') return parseCheckRegistered(data);
  return false;
}

function parseGroups(payload: unknown): ChannelGroupSummary[] {
  const arrayPayload =
    Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object'
        ? ((payload as Record<string, unknown>).data as unknown)
        : null;

  if (!Array.isArray(arrayPayload)) return [];

  return arrayPayload.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : typeof record.groupId === 'string' ? record.groupId : null;
    const subject =
      typeof record.subject === 'string'
        ? record.subject
        : typeof record.name === 'string'
          ? record.name
          : typeof record.title === 'string'
            ? record.title
            : '';
    if (!id || !subject) return [];
    return [{ id, subject }];
  });
}

function parseGroupMetadata(payload: unknown): ChannelGroupMetadata | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const source =
    root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : root;

  const announce =
    readBooleanLike(source.announce) ??
    readBooleanLike(source.isAnnounce) ??
    readBooleanLike(source.onlyAdminsCanSend) ??
    null;

  const participantsRaw = Array.isArray(source.participants) ? source.participants : null;
  const participants = participantsRaw
    ? participantsRaw.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        const id =
          typeof record.id === 'string'
            ? record.id
            : typeof record.contactId === 'string'
              ? record.contactId
              : typeof record.phone === 'string'
                ? `${record.phone}@c.us`
                : null;
        if (!id) return [];
        const isAdmin =
          readBooleanLike(record.isAdmin) ??
          readBooleanLike(record.admin) ??
          (typeof record.role === 'string' ? record.role.toLowerCase().includes('admin') : false) ??
          false;
        return [{ id, isAdmin: Boolean(isAdmin) }];
      })
    : null;

  return { announce, participants };
}

export function createOpenwaChannelService(): ChannelService {
  const client = createOpenwaClient();

  return {
    isReady(): boolean {
      return client.isConfigured();
    },

    getSelfJids(): string[] {
      return [];
    },

    async checkRegisteredNumber(jid: string): Promise<boolean> {
      const sessionId = await client.getSessionId();
      const digits = jid.replace(/[^\d]/g, '');
      const payload = await client.get<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/contacts/check/${encodeURIComponent(digits)}`);
      return parseCheckRegistered(payload);
    },

    async sendMessage(chatId: string, message: ChannelMessage): Promise<ChannelSendResult> {
      const sessionId = await client.getSessionId();
      const normalizedChatId = normalizeDirectChatId(chatId);

      let endpoint = '';
      let body: Record<string, unknown> = { chatId: normalizedChatId };

      switch (message.kind) {
        case 'text':
          endpoint = 'send-text';
          body = { ...body, text: message.text, mentions: message.mentions };
          break;
        case 'image': {
          endpoint = 'send-image';
          const base = { ...body, caption: message.caption ?? '', mentions: message.mentions };
          body =
            message.source.kind === 'url'
              ? { ...base, imageUrl: message.source.url, url: message.source.url }
              : { ...base, base64: encodeBase64(message.source.buffer) };
          break;
        }
        case 'document':
          endpoint = 'send-document';
          body = {
            ...body,
            base64: encodeBase64(message.document),
            fileName: message.fileName,
            filename: message.fileName,
            mimetype: message.mimetype,
            caption: message.caption ?? '',
            mentions: message.mentions,
          };
          break;
      }

      const raw = await client.post<unknown>(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages/${endpoint}`,
        body
      );

      return {
        messageId: extractMessageId(raw),
        remoteJid: normalizedChatId,
        raw,
      };
    },

    async listGroups(): Promise<ChannelGroupSummary[]> {
      const sessionId = await client.getSessionId();
      const payload = await client.get<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/groups`);
      return parseGroups(payload);
    },

    async getGroupMetadata(chatId: string): Promise<ChannelGroupMetadata | null> {
      const sessionId = await client.getSessionId();
      const payload = await client.get<unknown>(
        `/api/sessions/${encodeURIComponent(sessionId)}/groups/${encodeURIComponent(chatId)}`
      );
      return parseGroupMetadata(payload);
    },
  };
}
