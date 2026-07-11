import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OpenwaClient } from './openwaClient.js';

export type CapturedWebhookEvent = {
  captureId: string;
  capturedAt: string;
  headers: Record<string, string>;
  eventType: string | null;
  sessionId: string | null;
  payload: unknown;
};

type WebhookResponse = {
  id: string;
  sessionId: string;
  url: string;
  events: string[];
  active: boolean;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
};

const DEFAULT_EVENTS = [
  'message.received',
  'message.reaction',
  'session.status',
  'session.qr',
  'session.authenticated',
  'session.disconnected',
];

export class WebhookCaptureStore {
  private readonly captureDir: string;

  constructor(dataDir: string) {
    this.captureDir = path.join(dataDir, 'webhook-captures');
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.captureDir, { recursive: true });
  }

  private buildFilePath(captureId: string): string {
    return path.join(this.captureDir, `${captureId}.json`);
  }

  async save(args: { headers: Record<string, string>; payload: unknown }): Promise<CapturedWebhookEvent> {
    await this.ensureDir();

    const payloadRecord =
      args.payload && typeof args.payload === 'object' ? (args.payload as Record<string, unknown>) : {};
    const eventType =
      typeof payloadRecord.event === 'string'
        ? payloadRecord.event
        : typeof payloadRecord.type === 'string'
          ? payloadRecord.type
          : null;
    const sessionId =
      typeof payloadRecord.sessionId === 'string'
        ? payloadRecord.sessionId
        : typeof payloadRecord.session_id === 'string'
          ? payloadRecord.session_id
          : null;

    const event: CapturedWebhookEvent = {
      captureId: randomUUID(),
      capturedAt: new Date().toISOString(),
      headers: args.headers,
      eventType,
      sessionId,
      payload: args.payload,
    };

    await fs.writeFile(this.buildFilePath(event.captureId), JSON.stringify(event, null, 2), 'utf8');
    return event;
  }

  async listLatest(limit = 20): Promise<CapturedWebhookEvent[]> {
    await this.ensureDir();
    const entries = await fs.readdir(this.captureDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    const loaded = await Promise.all(
      files.map(async (file) => {
        const fullPath = path.join(this.captureDir, file.name);
        const stats = await fs.stat(fullPath);
        const content = await fs.readFile(fullPath, 'utf8');
        return {
          mtimeMs: stats.mtimeMs,
          event: JSON.parse(content) as CapturedWebhookEvent,
        };
      })
    );

    return loaded
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(1, limit))
      .map((entry) => entry.event);
  }

  async getLatestByEventType(eventType: string): Promise<CapturedWebhookEvent | null> {
    const events = await this.listLatest(100);
    return events.find((event) => event.eventType === eventType) ?? null;
  }
}

export class WebhookService {
  constructor(private readonly client: OpenwaClient) {}

  async listCurrentSessionWebhooks(): Promise<WebhookResponse[]> {
    const sessionId = await this.client.resolveSessionId();
    const payload = await this.client.get<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/webhooks`);
    return Array.isArray(payload) ? (payload as WebhookResponse[]) : [];
  }

  async ensureCurrentSessionWebhook(args: {
    url: string;
    secret?: string;
    headers?: Record<string, string>;
    retryCount?: number;
    events?: string[];
  }): Promise<{ created: boolean; webhook: WebhookResponse }> {
    const sessionId = await this.client.resolveSessionId();
    const existing = await this.listCurrentSessionWebhooks();
    const found = existing.find((item) => item.url === args.url);
    if (found) {
      return { created: false, webhook: found };
    }

    const webhook = await this.client.post<WebhookResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/webhooks`,
      {
        url: args.url,
        events: args.events ?? DEFAULT_EVENTS,
        secret: args.secret,
        headers: args.headers,
        retryCount: args.retryCount ?? 3,
      }
    );

    return { created: true, webhook };
  }
}

export function getDefaultWebhookEvents(): string[] {
  return [...DEFAULT_EVENTS];
}
