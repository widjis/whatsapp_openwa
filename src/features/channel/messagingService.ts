import type {
  ChannelSendResult,
  SendDocumentMessageInput,
  SendImageMessageInput,
  SendTextMessageInput,
} from './types.js';
import { OpenwaClient } from './openwaClient.js';

function normalizeDirectChatId(chatId: string): string {
  if (chatId.endsWith('@g.us') || chatId.endsWith('@c.us')) return chatId;
  if (chatId.endsWith('@s.whatsapp.net')) {
    const digits = chatId.split('@')[0]?.replace(/[^\d]/g, '') ?? '';
    return digits ? `${digits}@c.us` : chatId;
  }

  const digits = chatId.replace(/[^\d]/g, '');
  return digits ? `${digits}@c.us` : chatId;
}

function extractMessageId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  for (const candidate of [record.messageId, record.id, record.msgId]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }

  const data = record.data;
  return data && typeof data === 'object' ? extractMessageId(data) : undefined;
}

function extractTimestamp(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  for (const candidate of [record.timestamp, record.ts]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }

  const data = record.data;
  return data && typeof data === 'object' ? extractTimestamp(data) : undefined;
}

function encodeBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

export class MessagingService {
  constructor(private readonly client: OpenwaClient) {}

  async sendText(input: SendTextMessageInput): Promise<ChannelSendResult> {
    const sessionId = await this.client.resolveSessionId();
    const chatId = normalizeDirectChatId(input.chatId);
    const raw = await this.client.post<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`,
      { chatId, text: input.text, mentions: input.mentions }
    );

    return {
      messageId: extractMessageId(raw),
      timestamp: extractTimestamp(raw),
      remoteJid: chatId,
      raw,
    };
  }

  async sendImage(input: SendImageMessageInput): Promise<ChannelSendResult> {
    const sessionId = await this.client.resolveSessionId();
    const chatId = normalizeDirectChatId(input.chatId);
    const base = { chatId, caption: input.caption ?? '', mentions: input.mentions };
    const body =
      input.source.kind === 'url'
        ? { ...base, url: input.source.url, imageUrl: input.source.url }
        : {
            ...base,
            base64: encodeBase64(input.source.buffer),
            mimetype: input.source.mimetype,
            filename: input.source.filename,
          };

    const raw = await this.client.post<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-image`,
      body
    );

    return {
      messageId: extractMessageId(raw),
      timestamp: extractTimestamp(raw),
      remoteJid: chatId,
      raw,
    };
  }

  async sendDocument(input: SendDocumentMessageInput): Promise<ChannelSendResult> {
    const sessionId = await this.client.resolveSessionId();
    const chatId = normalizeDirectChatId(input.chatId);
    const raw = await this.client.post<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-document`,
      {
        chatId,
        base64: encodeBase64(input.document),
        mimetype: input.mimetype,
        filename: input.fileName,
        fileName: input.fileName,
        caption: input.caption ?? '',
        mentions: input.mentions,
      }
    );

    return {
      messageId: extractMessageId(raw),
      timestamp: extractTimestamp(raw),
      remoteJid: chatId,
      raw,
    };
  }

  async sendBulk(args: {
    messages: Array<{
      chatId: string;
      text: string;
    }>;
    delayBetweenMessages?: number;
    randomizeDelay?: boolean;
  }): Promise<unknown> {
    const sessionId = await this.client.resolveSessionId();
    return await this.client.post<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/messages/send-bulk`, {
      messages: args.messages.map((message) => ({
        chatId: normalizeDirectChatId(message.chatId),
        type: 'text',
        content: { text: message.text },
      })),
      options: {
        delayBetweenMessages: args.delayBetweenMessages,
        randomizeDelay: args.randomizeDelay,
      },
    });
  }
}
