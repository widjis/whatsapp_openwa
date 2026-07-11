import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_BASE_URL = 'http://10.60.10.59:2785';
const DEFAULT_NUMBER = '+6285712612218';

loadDotenv();
loadDotenv({ path: path.join(process.cwd(), 'scripts', '.env'), override: false });

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function getConfig() {
  const args = parseArgs(process.argv.slice(2));

  return {
    help: args.help === 'true',
    baseUrl: (args['base-url'] ?? process.env.OPENWA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: args['api-key'] ?? process.env.OPENWA_API_KEY ?? process.env.X_API_KEY ?? '',
    sessionId: args['session-id'] ?? process.env.OPENWA_SESSION_ID ?? '',
    sessionName: args['session-name'] ?? process.env.OPENWA_SESSION_NAME ?? '',
    number: args.number ?? process.env.OPENWA_TEST_NUMBER ?? DEFAULT_NUMBER,
    message:
      args.message ??
      process.env.OPENWA_TEST_MESSAGE ??
      `Test message from whatsapp_api_n8nv2 at ${new Date().toISOString()}`,
  };
}

function normalizeChatId(number) {
  const digits = String(number).replace(/[^\d]/g, '');
  if (!digits) {
    throw new Error(`Invalid number: ${number}`);
  }

  return `${digits}@c.us`;
}

async function httpJson(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}: ${detail}`);
  }

  return payload;
}

async function validateApiKey(config) {
  await httpJson(`${config.baseUrl}/api/auth/validate`, {
    method: 'POST',
    headers: {
      'X-API-Key': config.apiKey,
    },
  });
}

async function listSessions(config) {
  return await httpJson(`${config.baseUrl}/api/sessions`, {
    headers: {
      'X-API-Key': config.apiKey,
      Accept: 'application/json',
    },
  });
}

async function resolveSessionId(config) {
  if (config.sessionId) return config.sessionId;

  const sessions = await listSessions(config);
  if (!Array.isArray(sessions)) {
    throw new Error('Unexpected sessions response');
  }

  if (config.sessionName) {
    const foundByName = sessions.find((session) => session?.name === config.sessionName);
    if (!foundByName?.id) {
      throw new Error(`Session with name "${config.sessionName}" not found`);
    }
    return foundByName.id;
  }

  const readySessions = sessions.filter((session) => session?.status === 'ready' && typeof session?.id === 'string');
  if (readySessions.length === 1) {
    return readySessions[0].id;
  }

  const summary = sessions
    .map((session) => `${session?.name ?? 'unknown'} [${session?.status ?? 'unknown'}] => ${session?.id ?? 'no-id'}`)
    .join('\n');

  throw new Error(
    [
      'Unable to auto-select session.',
      'Set OPENWA_SESSION_ID or OPENWA_SESSION_NAME, or pass --session-id / --session-name.',
      '',
      'Available sessions:',
      summary || '(none)',
    ].join('\n'),
  );
}

async function sendTextMessage(config) {
  const sessionId = await resolveSessionId(config);
  const chatId = normalizeChatId(config.number);
  const url = `${config.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`;
  const body = {
    chatId,
    text: config.message,
  };

  const result = await httpJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-API-Key': config.apiKey,
    },
    body: JSON.stringify(body),
  });

  return { sessionId, chatId, body, result };
}

async function main() {
  const config = getConfig();

  if (config.help) {
    console.log(`Usage:
node scripts/test-openwa-send-text.mjs [options]

Options:
  --api-key <key>           OpenWA API key
  --base-url <url>          OpenWA base URL (default: ${DEFAULT_BASE_URL})
  --session-id <id>         Explicit OpenWA session ID
  --session-name <name>     Resolve session by name
  --number <phone>          Target phone number (default: ${DEFAULT_NUMBER})
  --message <text>          Message text to send
  --help                    Show this help

Environment fallback:
  OPENWA_API_KEY
  OPENWA_BASE_URL
  OPENWA_SESSION_ID
  OPENWA_SESSION_NAME
  OPENWA_TEST_NUMBER
  OPENWA_TEST_MESSAGE`);
    return;
  }

  if (!config.apiKey) {
    throw new Error(
      'Missing OpenWA API key. Set OPENWA_API_KEY in .env or pass --api-key "<your-key>".',
    );
  }

  console.log('[openwa-test] validating API key...');
  await validateApiKey(config);

  console.log('[openwa-test] sending text message...');
  const sent = await sendTextMessage(config);

  console.log('[openwa-test] success');
  console.log(
    JSON.stringify(
      {
        baseUrl: config.baseUrl,
        sessionId: sent.sessionId,
        chatId: sent.chatId,
        request: sent.body,
        response: sent.result,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[openwa-test] failed');
  console.error(message);
  process.exitCode = 1;
});
