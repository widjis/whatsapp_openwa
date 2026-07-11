type OpenwaConfig = {
  baseUrl: string;
  apiKey: string;
  sessionId?: string;
  sessionName?: string;
};

const DEFAULT_OPENWA_BASE_URL = 'http://10.60.10.59:2785';

function parseOpenwaArgs(): OpenwaConfig {
  const baseUrl = (process.env.OPENWA_BASE_URL ?? DEFAULT_OPENWA_BASE_URL).trim().replace(/\/+$/, '');
  const apiKey = (process.env.OPENWA_API_KEY ?? process.env.X_API_KEY ?? '').trim();
  const sessionId = (process.env.OPENWA_SESSION_ID ?? '').trim() || undefined;
  const sessionName = (process.env.OPENWA_SESSION_NAME ?? '').trim() || undefined;
  return { baseUrl, apiKey, sessionId, sessionName };
}

function hasMinimumConfig(config: OpenwaConfig): boolean {
  return Boolean(config.baseUrl && config.apiKey && (config.sessionId || config.sessionName));
}

function normalizeOpenwaError(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return 'Unknown OpenWA error';

  const record = payload as Record<string, unknown>;
  const candidates = [record.message, record.error, record.detail];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }

  return JSON.stringify(payload);
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
    throw new Error(`OpenWA ${response.status} ${response.statusText}: ${normalizeOpenwaError(payload)}`);
  }

  return payload as T;
}

export class OpenwaClient {
  private readonly config: OpenwaConfig;
  private resolvedSessionId: string | null;

  constructor(config?: Partial<OpenwaConfig>) {
    const base = parseOpenwaArgs();
    this.config = {
      baseUrl: config?.baseUrl ?? base.baseUrl,
      apiKey: config?.apiKey ?? base.apiKey,
      sessionId: config?.sessionId ?? base.sessionId,
      sessionName: config?.sessionName ?? base.sessionName,
    };
    this.resolvedSessionId = this.config.sessionId ?? null;
  }

  isConfigured(): boolean {
    return hasMinimumConfig(this.config);
  }

  async listSessions(): Promise<unknown[]> {
    const sessions = await openwaJson<unknown>(`${this.config.baseUrl}/api/sessions`, { method: 'GET' }, this.config.apiKey);
    return Array.isArray(sessions) ? sessions : [];
  }

  async getSessionId(): Promise<string> {
    if (this.resolvedSessionId) return this.resolvedSessionId;
    if (!this.isConfigured()) {
      throw new Error('OpenWA is not fully configured. Expected OPENWA_BASE_URL, OPENWA_API_KEY, and OPENWA_SESSION_ID or OPENWA_SESSION_NAME.');
    }

    const sessions = await this.listSessions();
    if (this.config.sessionName) {
      const found = sessions.find((session) => {
        if (!session || typeof session !== 'object') return false;
        const record = session as Record<string, unknown>;
        return record.name === this.config.sessionName && typeof record.id === 'string';
      }) as { id?: string } | undefined;

      if (!found?.id) {
        throw new Error(`OpenWA session "${this.config.sessionName}" was not found.`);
      }

      this.resolvedSessionId = found.id;
      return found.id;
    }

    throw new Error('OpenWA session could not be resolved. Set OPENWA_SESSION_ID or OPENWA_SESSION_NAME.');
  }

  async get<T>(path: string): Promise<T> {
    return await openwaJson<T>(`${this.config.baseUrl}${path}`, { method: 'GET' }, this.config.apiKey);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return await openwaJson<T>(
      `${this.config.baseUrl}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      this.config.apiKey
    );
  }
}

export function createOpenwaClient(): OpenwaClient {
  return new OpenwaClient();
}
