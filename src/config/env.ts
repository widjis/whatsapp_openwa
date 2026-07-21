import path from 'node:path';

export type AppConfig = {
  port: number;
  allowedIps: string[];
  allowedPhoneNumbers: string[];
  dataDir: string;
  logging: {
    enabled: boolean;
    directory: string;
    captureConsole: boolean;
    maxFiles: number;
    debugEndpointEnabled: boolean;
  };
  n8n: {
    enabled: boolean;
    webhookUrl?: string;
    apiKey?: string;
    timeoutMs: number;
    debug: boolean;
    fallbackText?: string;
  };
  openwa: {
    baseUrl: string;
    apiKey: string;
    sessionId?: string;
    sessionName?: string;
    webhookSecret?: string;
    webhookUrl?: string;
  };
};

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAllowedIps(value: string | undefined): string[] {
  const merged = new Set(['127.0.0.1', '::1', ...parseCsv(value)]);
  return Array.from(merged);
}

function parseOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'n') return false;
  return undefined;
}

export function loadConfig(projectRoot: string): AppConfig {
  const dataDirRaw = parseOptional(process.env.DATA_DIR) ?? 'data';
  const n8nWebhookUrl = parseOptional(process.env.N8N_WEBHOOK_URL);
  const n8nEnabled = parseBoolean(process.env.N8N_ENABLED) ?? Boolean(n8nWebhookUrl);
  const n8nFallbackEnabled = parseBoolean(process.env.N8N_FALLBACK_ENABLED) ?? true;

  return {
    port: parsePort(process.env.PORT, 8192),
    allowedIps: parseAllowedIps(process.env.ALLOWED_IPS),
    allowedPhoneNumbers: parseCsv(process.env.ALLOWED_PHONE_NUMBERS),
    dataDir: path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(projectRoot, dataDirRaw),
    logging: {
      enabled: parseBoolean(process.env.LOGGING_ENABLED) ?? true,
      directory: path.isAbsolute(parseOptional(process.env.LOGGING_DIR) ?? '')
        ? (parseOptional(process.env.LOGGING_DIR) as string)
        : path.join(path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(projectRoot, dataDirRaw), parseOptional(process.env.LOGGING_DIR) ?? 'logs'),
      captureConsole: parseBoolean(process.env.LOGGING_CAPTURE_CONSOLE) ?? true,
      maxFiles: parsePort(process.env.LOGGING_MAX_FILES, 14),
      debugEndpointEnabled: parseBoolean(process.env.LOGGING_DEBUG_ENDPOINT_ENABLED) ?? true,
    },
    n8n: {
      enabled: n8nEnabled,
      webhookUrl: n8nWebhookUrl,
      apiKey: parseOptional(process.env.N8N_API_KEY),
      timeoutMs: parsePort(process.env.N8N_TIMEOUT, 60_000),
      debug: parseBoolean(process.env.N8N_DEBUG) ?? false,
      fallbackText: n8nFallbackEnabled
        ? parseOptional(process.env.N8N_FALLBACK_TEXT) ?? 'AI system not available. Please try again later.'
        : undefined,
    },
    openwa: {
      baseUrl: (parseOptional(process.env.OPENWA_BASE_URL) ?? 'http://10.60.10.59:2785').replace(/\/+$/, ''),
      apiKey: parseOptional(process.env.OPENWA_API_KEY) ?? '',
      sessionId: parseOptional(process.env.OPENWA_SESSION_ID),
      sessionName: parseOptional(process.env.OPENWA_SESSION_NAME),
      webhookSecret: parseOptional(process.env.OPENWA_WEBHOOK_SECRET),
      webhookUrl: parseOptional(process.env.OPENWA_WEBHOOK_URL),
    },
  };
}
