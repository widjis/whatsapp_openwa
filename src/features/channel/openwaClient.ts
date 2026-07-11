import type { AppConfig } from '../../config/env.js';
import type { SessionSummary } from './types.js';

type OpenwaErrorCategory =
  | 'not_ready'
  | 'not_found'
  | 'invalid_request'
  | 'auth_failed'
  | 'rate_limited'
  | 'provider_error';

export class OpenwaClientError extends Error {
  readonly category: OpenwaErrorCategory;
  readonly statusCode: number;
  readonly payload: unknown;

  constructor(args: { message: string; category: OpenwaErrorCategory; statusCode: number; payload: unknown }) {
    super(args.message);
    this.name = 'OpenwaClientError';
    this.category = args.category;
    this.statusCode = args.statusCode;
    this.payload = args.payload;
  }
}

function normalizeOpenwaError(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return 'Unknown OpenWA error';

  const record = payload as Record<string, unknown>;
  for (const candidate of [record.message, record.error, record.detail]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }

  return JSON.stringify(payload);
}

function categorizeStatus(statusCode: number): OpenwaErrorCategory {
  if (statusCode === 400) return 'invalid_request';
  if (statusCode === 401 || statusCode === 403) return 'auth_failed';
  if (statusCode === 404) return 'not_found';
  if (statusCode === 409 || statusCode === 422) return 'invalid_request';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode >= 500) return 'provider_error';
  return 'provider_error';
}

async function openwaJson<T>(url: string, options: RequestInit, apiKey: string): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'X-API-Key': apiKey,
      ...(options.headers ?? {}),
    },
  });

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    throw new OpenwaClientError({
      message: `OpenWA ${response.status} ${response.statusText}: ${normalizeOpenwaError(payload)}`,
      category: categorizeStatus(response.status),
      statusCode: response.status,
      payload,
    });
  }

  return payload as T;
}

export class OpenwaClient {
  private readonly config: AppConfig['openwa'];
  private resolvedSessionId: string | null;

  constructor(config: AppConfig['openwa']) {
    this.config = config;
    this.resolvedSessionId = config.sessionId ?? null;
  }

  isConfigured(): boolean {
    return Boolean(this.config.baseUrl && this.config.apiKey && (this.config.sessionId || this.config.sessionName));
  }

  assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error(
        'OpenWA is not fully configured. Expected OPENWA_BASE_URL, OPENWA_API_KEY, and OPENWA_SESSION_ID or OPENWA_SESSION_NAME.'
      );
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    this.assertConfigured();
    const sessions = await openwaJson<unknown>(`${this.config.baseUrl}/api/sessions`, { method: 'GET' }, this.config.apiKey);
    return Array.isArray(sessions) ? (sessions as SessionSummary[]) : [];
  }

  async resolveSessionId(): Promise<string> {
    if (this.resolvedSessionId) return this.resolvedSessionId;
    this.assertConfigured();

    const sessions = await this.listSessions();
    const found = sessions.find((session) => session.name === this.config.sessionName);
    if (!found?.id) {
      throw new Error(`OpenWA session "${this.config.sessionName}" was not found.`);
    }

    this.resolvedSessionId = found.id;
    return found.id;
  }

  async get<T>(path: string): Promise<T> {
    this.assertConfigured();
    return await openwaJson<T>(`${this.config.baseUrl}${path}`, { method: 'GET' }, this.config.apiKey);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    this.assertConfigured();
    return await openwaJson<T>(
      `${this.config.baseUrl}${path}`,
      {
        method: 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      this.config.apiKey
    );
  }
}
