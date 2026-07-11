import path from 'node:path';

export type AppConfig = {
  port: number;
  allowedIps: string[];
  allowedPhoneNumbers: string[];
  dataDir: string;
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

export function loadConfig(projectRoot: string): AppConfig {
  const dataDirRaw = parseOptional(process.env.DATA_DIR) ?? 'data';

  return {
    port: parsePort(process.env.PORT, 8192),
    allowedIps: parseAllowedIps(process.env.ALLOWED_IPS),
    allowedPhoneNumbers: parseCsv(process.env.ALLOWED_PHONE_NUMBERS),
    dataDir: path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(projectRoot, dataDirRaw),
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
