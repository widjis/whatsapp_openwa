import express from 'express';
import { createServer } from 'node:http';
import { Server as SocketIoServer } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import multer from 'multer';
import dotenv from 'dotenv';
import { pino } from 'pino';
import { createConfiguredChannelService, getConfiguredChannelProviderName } from './features/channel/factory.js';
import { makeInMemoryStore } from './features/whatsapp/store.js';
import { startWhatsApp, getSocket, checkRegisteredNumber } from './features/whatsapp/start.js';
import { createCheckIpMiddleware } from './features/http/middleware/checkIp.js';
import { registerMessageRoutes } from './features/http/routes/messages.js';
import { startHelpdeskDispatcher } from './features/dispatcher/helpdeskDispatcher.js';
import { downloadSharepointFileToPath } from './sharepointDownloadLeaveSchedule.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function resolveDataDir(rootDir: string): string | null {
  const raw = process.env.DATA_DIR;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return path.isAbsolute(trimmed) ? trimmed : path.join(rootDir, trimmed);
}

function resolveSharepointTokenCachePath(dataDirResolved: string): string {
  const raw = process.env.SHAREPOINT_TOKEN_CACHE_PATH;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const trimmed = raw.trim();
    return path.isAbsolute(trimmed) ? trimmed : path.join(dataDirResolved, trimmed);
  }
  return path.join(dataDirResolved, 'sharepoint_token_cache.json');
}

const app = express();
const server = createServer(app);
const io = new SocketIoServer(server);
const channel = createConfiguredChannelService();
const channelProvider = getConfiguredChannelProviderName();

const dispatcher = startHelpdeskDispatcher();

function shutdown() {
  dispatcher.stop();
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const portRaw = process.env.PORT;
const port = portRaw ? Number(portRaw) : 8192;
const n8nTimeoutMs = process.env.N8N_TIMEOUT ? Number(process.env.N8N_TIMEOUT) : 5000;

const allowedIps = (process.env.ALLOWED_IPS ?? '127.0.0.1,::1')
  .split(',')
  .map((ip) => ip.trim())
  .filter(Boolean);

const allowedPhoneNumbers = (process.env.ALLOWED_PHONE_NUMBERS ?? '')
  .split(',')
  .map((num) => num.trim())
  .filter(Boolean);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.sendFile(path.join(projectRoot, 'index.html'));
});

const dataDir = resolveDataDir(projectRoot);
if (dataDir && !fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const uploadsDir = path.join(dataDir ?? projectRoot, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    cb(null, file.originalname);
  },
});

const upload = multer({ storage });

const store = makeInMemoryStore({ logger: pino({ level: 'fatal' }) });
const storeFilePath = path.join(dataDir ?? projectRoot, 'baileys_store.json');
store.readFromFile(storeFilePath);

setInterval(() => {
  store.writeToFile(storeFilePath);
}, 10_000);

const checkIp = createCheckIpMiddleware({
  allowedIps,
  getSocket,
  alertReceiverJid: '6285712612218@s.whatsapp.net',
});

app.use('/uploads', (req, res, next) => {
  const result = checkIp(req, res, () => next());
  if (result instanceof Promise) {
    void result.catch(next);
  }
}, express.static(uploadsDir));

registerMessageRoutes({
  app,
  upload,
  checkIp,
  getChannel: () => channel,
});

console.log(`[channel] outbound provider: ${channelProvider}`);

function parseBoolean(raw: string | undefined): boolean | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'y') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'n') return false;
  return null;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function computeNextDelayMs(args: { tzOffsetHours: number; hour: number; minute: number }): number {
  const nowUtcMs = Date.now();
  const offsetMs = args.tzOffsetHours * 60 * 60_000;
  const nowLocal = new Date(nowUtcMs + offsetMs);
  const y = nowLocal.getUTCFullYear();
  const m = nowLocal.getUTCMonth();
  const d = nowLocal.getUTCDate();
  const currentMinutes = nowLocal.getUTCHours() * 60 + nowLocal.getUTCMinutes();
  const targetMinutes = args.hour * 60 + args.minute;
  const addDays = currentMinutes >= targetMinutes ? 1 : 0;
  const targetLocalUtcMs = Date.UTC(y, m, d + addDays, args.hour, args.minute, 0, 0);
  const targetUtcMs = targetLocalUtcMs - offsetMs;
  return Math.max(1_000, targetUtcMs - nowUtcMs);
}

function localIsoDateForOffsetHours(offsetHours: number): string {
  const nowUtcMs = Date.now();
  const offsetMs = offsetHours * 60 * 60_000;
  const nowLocal = new Date(nowUtcMs + offsetMs);
  const y = nowLocal.getUTCFullYear();
  const m = String(nowLocal.getUTCMonth() + 1).padStart(2, '0');
  const d = String(nowLocal.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

let leaveScheduleAutoDownloadInFlight = false;
let leaveScheduleAutoDownloadLastSuccessDateIso: string | null = null;

async function runLeaveScheduleAutoDownload(): Promise<void> {
  if (leaveScheduleAutoDownloadInFlight) return;
  const shareUrl = typeof process.env.LEAVE_SCHEDULE_SHARE_URL === 'string' ? process.env.LEAVE_SCHEDULE_SHARE_URL.trim() : '';
  if (!shareUrl) return;

  const enabled = parseBoolean(process.env.LEAVE_SCHEDULE_AUTO_DOWNLOAD_ENABLED);
  if (enabled === false) return;

  const tzOffsetHours = parseIntEnv('LEAVE_SCHEDULE_AUTO_DOWNLOAD_TZ_OFFSET_HOURS', 8);
  const todayIso = localIsoDateForOffsetHours(tzOffsetHours);
  if (leaveScheduleAutoDownloadLastSuccessDateIso === todayIso) return;

  const dataDirResolved = dataDir ?? path.join(projectRoot, 'data');
  const tenantId = process.env.MS_TENANT_ID?.trim();
  const clientId = process.env.MS_CLIENT_ID?.trim();
  if (!tenantId || !clientId) {
    console.error('Leave schedule auto-download skipped: missing MS_TENANT_ID or MS_CLIENT_ID');
    return;
  }

  const scope =
    typeof process.env.MS_GRAPH_SCOPES === 'string' && process.env.MS_GRAPH_SCOPES.trim().length > 0 ? process.env.MS_GRAPH_SCOPES.trim() : 'Files.Read';

  const tokenCachePath = resolveSharepointTokenCachePath(dataDirResolved);
  await fsPromises.mkdir(path.dirname(tokenCachePath), { recursive: true });

  const targetPath =
    typeof process.env.DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH === 'string' && process.env.DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH.trim().length > 0
      ? process.env.DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH.trim()
      : path.join(dataDirResolved, 'MTI - Leave Schedule (ICT Team).xlsx');

  leaveScheduleAutoDownloadInFlight = true;
  try {
    const res = await downloadSharepointFileToPath({
      shareUrl,
      tenantId,
      clientId,
      scope,
      tokenCachePath,
      targetPath,
    });
    await fsPromises.utimes(res.targetPath, new Date(), new Date());
    leaveScheduleAutoDownloadLastSuccessDateIso = todayIso;
    console.log(`Leave schedule downloaded: ${res.targetPath} (${res.bytes} bytes)`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Leave schedule auto-download failed: ${message}`);
  } finally {
    leaveScheduleAutoDownloadInFlight = false;
  }
}

function startLeaveScheduleAutoDownloadScheduler(): void {
  const shareUrl = typeof process.env.LEAVE_SCHEDULE_SHARE_URL === 'string' ? process.env.LEAVE_SCHEDULE_SHARE_URL.trim() : '';
  if (!shareUrl) return;

  const enabled = parseBoolean(process.env.LEAVE_SCHEDULE_AUTO_DOWNLOAD_ENABLED);
  if (enabled === false) return;

  const tzOffsetHours = parseIntEnv('LEAVE_SCHEDULE_AUTO_DOWNLOAD_TZ_OFFSET_HOURS', 8);
  const hour = Math.min(23, Math.max(0, parseIntEnv('LEAVE_SCHEDULE_AUTO_DOWNLOAD_HOUR', 6)));
  const minute = Math.min(59, Math.max(0, parseIntEnv('LEAVE_SCHEDULE_AUTO_DOWNLOAD_MINUTE', 0)));
  const runOnStartup = parseBoolean(process.env.LEAVE_SCHEDULE_AUTO_DOWNLOAD_RUN_ON_STARTUP) === true;

  if (runOnStartup) {
    void runLeaveScheduleAutoDownload();
  } else {
    console.log(
      'Leave schedule startup download skipped (set LEAVE_SCHEDULE_AUTO_DOWNLOAD_RUN_ON_STARTUP=true to enable).'
    );
  }

  const scheduleNext = () => {
    const delayMs = computeNextDelayMs({ tzOffsetHours, hour, minute });
    setTimeout(() => {
      void runLeaveScheduleAutoDownload().finally(() => {
        scheduleNext();
      });
    }, delayMs);
  };

  scheduleNext();
}

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
  const authInfoDir = path.join(dataDir ?? projectRoot, 'auth_info_baileys');
  if (!fs.existsSync(authInfoDir)) {
    fs.mkdirSync(authInfoDir, { recursive: true });
  }
  startLeaveScheduleAutoDownloadScheduler();
  void startWhatsApp({
    io,
    store,
    authInfoDir,
    n8nWebhookUrl: process.env.N8N_WEBHOOK_URL,
    n8nTimeoutMs,
    allowedPhoneNumbers,
  });
});
