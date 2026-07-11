import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

type CliOverrides = {
  command: string;
};

function applyCliEnvOverrides(rawArgs: string[]): CliOverrides {
  const args = Array.isArray(rawArgs) ? [...rawArgs] : [];
  const first = args[0];
  const command = first && !first.startsWith('--') ? String(args.shift()) : 'send';

  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const eqIndex = arg.indexOf('=');
    if (eqIndex === -1) continue;
    const key = arg.slice(2, eqIndex);
    const value = arg.slice(eqIndex + 1);

    if (key === 'auth-mode') process.env.QONTAK_AUTH_MODE = value;
    if (key === 'access-token') process.env.QONTAK_ACCESS_TOKEN = value;
    if (key === 'hmac-client-id') process.env.MEKARI_API_CLIENT_ID = value;
    if (key === 'hmac-client-secret') process.env.MEKARI_API_CLIENT_SECRET = value;
    if (key === 'oauth-refresh-token') process.env.MEKARI_OAUTH_REFRESH_TOKEN = value;
    if (key === 'oauth-client-id') process.env.MEKARI_OAUTH_CLIENT_ID = value;
    if (key === 'oauth-client-secret') process.env.MEKARI_OAUTH_CLIENT_SECRET = value;
    if (key === 'oauth-token-url') process.env.MEKARI_OAUTH_TOKEN_URL = value;
    if (key === 'base-url') process.env.QONTAK_BASE_URL = value;
    if (key === 'templates-path') process.env.QONTAK_TEMPLATES_PATH = value;
    if (key === 'limit') process.env.QONTAK_TEMPLATES_LIMIT = value;
    if (key === 'offset') process.env.QONTAK_TEMPLATES_OFFSET = value;
  }

  return { command };
}

function buildUrl(baseUrl: string, urlPath: string, query?: Record<string, string | undefined>) {
  const url = new URL(urlPath, baseUrl);
  if (!query) return url;
  for (const [key, value] of Object.entries(query)) {
    if (!value) continue;
    url.searchParams.set(key, value);
  }
  return url;
}

function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }
  return value;
}

function readOptionalJsonEnv(name: string): unknown | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  return JSON.parse(raw) as unknown;
}

type SendBody = {
  to_name: string;
  to_number: string;
  message_template_id: string;
  channel_integration_id: string;
  language: { code: string };
  parameters?: unknown;
};

function createBody(): SendBody {
  const toNumber = mustGetEnv('QONTAK_TO_NUMBER');
  const toName = process.env.QONTAK_TO_NAME || 'Customer';
  const messageTemplateId = mustGetEnv('QONTAK_MESSAGE_TEMPLATE_ID');
  const channelIntegrationId = mustGetEnv('QONTAK_CHANNEL_INTEGRATION_ID');
  const languageCode = process.env.QONTAK_LANGUAGE_CODE || 'id';
  const parameters = readOptionalJsonEnv('QONTAK_TEMPLATE_PARAMETERS_JSON');

  const body: SendBody = {
    to_name: toName,
    to_number: toNumber,
    message_template_id: messageTemplateId,
    channel_integration_id: channelIntegrationId,
    language: { code: languageCode },
  };

  if (parameters) {
    body.parameters = parameters;
  }

  return body;
}

function createDigestBase64(bodyString: string): string {
  return crypto.createHash('sha256').update(bodyString).digest('base64');
}

function createHmacAuthorization(args: {
  clientId: string;
  clientSecret: string;
  method: string;
  pathWithQuery: string;
  date: string;
}): string {
  const requestLine = `${args.method.toUpperCase()} ${args.pathWithQuery} HTTP/1.1`;
  const payload = [`date: ${args.date}`, requestLine].join('\n');
  const signature = crypto.createHmac('sha256', String(args.clientSecret)).update(payload).digest('base64');
  return `hmac username="${args.clientId}", algorithm="hmac-sha256", headers="date request-line", signature="${signature}"`;
}

type TokenRefreshSuccess = { access_token: string };

function isTokenRefreshSuccess(value: unknown): value is TokenRefreshSuccess {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    'access_token' in (value as Record<string, unknown>) &&
    typeof (value as Record<string, unknown>).access_token === 'string' &&
    Boolean((value as Record<string, unknown>).access_token)
  );
}

async function refreshMekariAccessToken(): Promise<string> {
  const tokenUrl = process.env.MEKARI_OAUTH_TOKEN_URL || 'https://account.mekari.com/auth/oauth2/token';
  const clientId = process.env.MEKARI_OAUTH_CLIENT_ID || process.env.MEKARI_API_CLIENT_ID;
  const clientSecret = process.env.MEKARI_OAUTH_CLIENT_SECRET || process.env.MEKARI_API_CLIENT_SECRET;
  const refreshToken = process.env.MEKARI_OAUTH_REFRESH_TOKEN;

  if (!clientId) throw new Error('Missing env: MEKARI_OAUTH_CLIENT_ID (or MEKARI_API_CLIENT_ID)');
  if (!clientSecret) throw new Error('Missing env: MEKARI_OAUTH_CLIENT_SECRET (or MEKARI_API_CLIENT_SECRET)');
  if (!refreshToken) throw new Error('Missing env: MEKARI_OAUTH_REFRESH_TOKEN');
  const scope = process.env.MEKARI_OAUTH_SCOPE;

  const jsonPayload: Record<string, string> = {
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  };
  if (scope) jsonPayload.scope = scope;

  const attempts: Array<{ name: string; request: RequestInit }> = [];
  attempts.push({
    name: 'json',
    request: {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(jsonPayload),
    },
  });

  const formParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (scope) formParams.set('scope', scope);
  attempts.push({
    name: 'form',
    request: {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formParams.toString(),
    },
  });

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const basicFormParams = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (scope) basicFormParams.set('scope', scope);
  attempts.push({
    name: 'basic+form',
    request: {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: basicFormParams.toString(),
    },
  });

  let lastErrorMessage = '';

  for (const attempt of attempts) {
    const response = await fetch(tokenUrl, attempt.request);
    const contentType = response.headers.get('content-type') || '';
    const responseBody: unknown = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      lastErrorMessage = `Mekari token refresh failed (${attempt.name}): ${response.status} ${response.statusText} ${JSON.stringify(responseBody)}`;
      continue;
    }

    if (!isTokenRefreshSuccess(responseBody)) {
      lastErrorMessage = `Mekari token refresh failed (${attempt.name}): missing access_token in response`;
      continue;
    }

    return responseBody.access_token;
  }

  throw new Error(lastErrorMessage || 'Mekari token refresh failed');
}

async function resolveBearerAccessToken(): Promise<string> {
  const configuredAccessToken = process.env.QONTAK_ACCESS_TOKEN;
  if (configuredAccessToken) return configuredAccessToken;

  const hasRefreshEnv = Boolean(process.env.MEKARI_OAUTH_CLIENT_ID || process.env.MEKARI_API_CLIENT_ID) &&
    Boolean(process.env.MEKARI_OAUTH_CLIENT_SECRET || process.env.MEKARI_API_CLIENT_SECRET) &&
    Boolean(process.env.MEKARI_OAUTH_REFRESH_TOKEN);
  if (!hasRefreshEnv) {
    throw new Error(
      'Missing env: QONTAK_ACCESS_TOKEN (or MEKARI_OAUTH_REFRESH_TOKEN plus OAuth client credentials)'
    );
  }

  return refreshMekariAccessToken();
}

async function createRequestHeaders(args: {
  method: string;
  url: URL;
  date: string;
  bodyString?: string;
}): Promise<Record<string, string>> {
  const authMode = (process.env.QONTAK_AUTH_MODE || 'hmac').toLowerCase();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Date: args.date,
  };

  if (args.bodyString !== undefined) {
    const digestBase64 = createDigestBase64(args.bodyString);
    headers['Content-Type'] = 'application/json';
    headers.Digest = `SHA-256=${digestBase64}`;
  }

  if (authMode === 'bearer') {
    const accessToken = await resolveBearerAccessToken();
    headers.Authorization = `Bearer ${accessToken}`;
    return headers;
  }

  const clientId = mustGetEnv('MEKARI_API_CLIENT_ID');
  const clientSecret = mustGetEnv('MEKARI_API_CLIENT_SECRET');
  headers.Authorization = createHmacAuthorization({
    clientId,
    clientSecret,
    method: args.method,
    pathWithQuery: args.url.pathname + args.url.search,
    date: args.date,
  });
  return headers;
}

async function sendWhatsAppTemplate(): Promise<unknown> {
  const baseUrl = process.env.QONTAK_BASE_URL || 'https://api.mekari.com';
  const urlPath = process.env.QONTAK_PATH || '/qontak/chat/v1/broadcasts/whatsapp/direct';
  const method = 'POST';
  const date = new Date().toUTCString();

  const url = buildUrl(baseUrl, urlPath);
  const body = createBody();
  const bodyString = JSON.stringify(body);
  const headers = await createRequestHeaders({ method, url, date, bodyString });

  const response = await fetch(url.toString(), { method, headers, body: bodyString });
  const contentType = response.headers.get('content-type') || '';
  const responseBody: unknown = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    throw new Error(
      `Qontak send failed: ${response.status} ${response.statusText} ${JSON.stringify(responseBody)}`
    );
  }

  return responseBody;
}

async function listWhatsAppTemplates(): Promise<unknown> {
  const baseUrl = process.env.QONTAK_BASE_URL || 'https://api.mekari.com';
  const configuredPath = process.env.QONTAK_TEMPLATES_PATH;
  const paths = configuredPath
    ? [configuredPath]
    : ['/qontak/chat/v1/whatsapp_templates', '/qontak/chat/v1/templates/whatsapp'];
  const method = 'GET';
  const date = new Date().toUTCString();
  let lastErrorMessage = '';

  for (const urlPath of paths) {
    const url = buildUrl(baseUrl, urlPath, {
      offset: process.env.QONTAK_TEMPLATES_OFFSET,
      limit: process.env.QONTAK_TEMPLATES_LIMIT,
      cursor: process.env.QONTAK_TEMPLATES_CURSOR,
      cursor_direction: process.env.QONTAK_TEMPLATES_CURSOR_DIRECTION,
      category: process.env.QONTAK_TEMPLATES_CATEGORY,
      status: process.env.QONTAK_TEMPLATES_STATUS,
    });

    const headers = await createRequestHeaders({ method, url, date });
    const response = await fetch(url.toString(), { method, headers });
    const contentType = response.headers.get('content-type') || '';
    const responseBody: unknown = contentType.includes('application/json') ? await response.json() : await response.text();

    if (response.ok) return responseBody;
    lastErrorMessage = `Qontak list templates failed: ${response.status} ${response.statusText} ${JSON.stringify(responseBody)}`;

    const shouldTryNextPath =
      !configuredPath &&
      response.status === 404 &&
      Boolean(responseBody) &&
      typeof responseBody === 'object' &&
      'code' in (responseBody as Record<string, unknown>) &&
      (responseBody as Record<string, unknown>).code === 'MAG-006';

    if (shouldTryNextPath) continue;
    break;
  }

  throw new Error(lastErrorMessage);
}

try {
  const { command } = applyCliEnvOverrides(process.argv.slice(2));
  const result = command === 'list-templates' ? await listWhatsAppTemplates() : await sendWhatsAppTemplate();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

