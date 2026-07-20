import dotenv from 'dotenv'
import express from 'express'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import multer from 'multer'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config/env.js'
import { OpenwaClient } from './features/channel/openwaClient.js'
import { SessionService } from './features/channel/sessionService.js'
import { MessagingService } from './features/channel/messagingService.js'
import { DirectoryService } from './features/channel/directoryService.js'
import { WebhookCaptureStore, WebhookService } from './features/channel/webhookService.js'
import { startHelpdeskDispatcher } from './features/dispatcher/helpdeskDispatcher.js'
import { InboundCommandService } from './features/inbound/commandService.js'
import { LdapService } from './features/integrations/ldap.js'
import { createCheckIpMiddleware } from './features/http/middleware/checkIp.js'
import { registerMessageRoutes } from './features/http/routes/messages.js'
import { registerChannelRoutes } from './features/http/routes/channel.js'
import { registerWebhookRoutes } from './features/http/routes/webhooks.js'
import { downloadSharepointFileToPath, resolveSharepointTokenCachePath } from './sharepointDownloadLeaveSchedule.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const config = loadConfig(projectRoot)
const app = express()

function parseBoolean(raw: string | undefined): boolean | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  if (value === 'true' || value === '1' || value === 'yes' || value === 'y') return true
  if (value === 'false' || value === '0' || value === 'no' || value === 'n') return false
  return null
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  const parsed = typeof raw === 'string' ? Number(raw) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.floor(parsed)
}

function computeNextDelayMs(args: { tzOffsetHours: number; hour: number; minute: number }): number {
  const nowUtcMs = Date.now()
  const offsetMs = args.tzOffsetHours * 60 * 60_000
  const nowLocal = new Date(nowUtcMs + offsetMs)
  const year = nowLocal.getUTCFullYear()
  const month = nowLocal.getUTCMonth()
  const day = nowLocal.getUTCDate()
  const currentMinutes = nowLocal.getUTCHours() * 60 + nowLocal.getUTCMinutes()
  const targetMinutes = args.hour * 60 + args.minute
  const addDays = currentMinutes >= targetMinutes ? 1 : 0
  const targetLocalUtcMs = Date.UTC(year, month, day + addDays, args.hour, args.minute, 0, 0)
  const targetUtcMs = targetLocalUtcMs - offsetMs
  return Math.max(1_000, targetUtcMs - nowUtcMs)
}

function localIsoDateForOffsetHours(offsetHours: number): string {
  const nowUtcMs = Date.now()
  const offsetMs = offsetHours * 60 * 60_000
  const nowLocal = new Date(nowUtcMs + offsetMs)
  const year = nowLocal.getUTCFullYear()
  const month = String(nowLocal.getUTCMonth() + 1).padStart(2, '0')
  const day = String(nowLocal.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getGraphScopesEnv(): string {
  if (process.env.MS_GRAPH_SCOPES?.trim()) return process.env.MS_GRAPH_SCOPES.trim()
  if (process.env.MS_SCOPES?.trim()) return process.env.MS_SCOPES.trim()
  return 'Files.Read'
}

let leaveScheduleAutoDownloadInFlight = false
let leaveScheduleAutoDownloadLastSuccessDateIso: string | null = null

async function runLeaveScheduleAutoDownload(): Promise<void> {
  if (leaveScheduleAutoDownloadInFlight) return

  const shareUrl = process.env.LEAVE_SCHEDULE_SHARE_URL?.trim() ?? ''
  if (!shareUrl) return

  const enabled = parseBoolean(process.env.LEAVE_SCHEDULE_AUTO_DOWNLOAD_ENABLED)
  if (enabled === false) return

  const tzOffsetHours = parseIntEnv('LEAVE_SCHEDULE_AUTO_DOWNLOAD_TZ_OFFSET_HOURS', 8)
  const todayIso = localIsoDateForOffsetHours(tzOffsetHours)
  if (leaveScheduleAutoDownloadLastSuccessDateIso === todayIso) return

  const tenantId = process.env.MS_TENANT_ID?.trim()
  const clientId = process.env.MS_CLIENT_ID?.trim()
  if (!tenantId || !clientId) {
    console.error('Leave schedule auto-download skipped: missing MS_TENANT_ID or MS_CLIENT_ID')
    return
  }

  const scope =
    getGraphScopesEnv()

  const tokenCachePath = resolveSharepointTokenCachePath(config.dataDir)
  const targetPath =
    process.env.DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH?.trim() && process.env.DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH.trim().length > 0
      ? process.env.DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH.trim()
      : path.join(config.dataDir, 'leave', 'leave-schedule.xlsx')

  leaveScheduleAutoDownloadInFlight = true
  try {
    await fsPromises.mkdir(path.dirname(tokenCachePath), { recursive: true })
    const result = await downloadSharepointFileToPath({
      shareUrl,
      tenantId,
      clientId,
      scope,
      tokenCachePath,
      targetPath,
    })
    await fsPromises.utimes(result.targetPath, new Date(), new Date())
    leaveScheduleAutoDownloadLastSuccessDateIso = todayIso
    console.log(`Leave schedule downloaded: ${result.targetPath} (${result.bytes} bytes)`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Leave schedule auto-download failed: ${message}`)
  } finally {
    leaveScheduleAutoDownloadInFlight = false
  }
}

function startLeaveScheduleAutoDownloadScheduler(): void {
  const shareUrl = process.env.LEAVE_SCHEDULE_SHARE_URL?.trim() ?? ''
  if (!shareUrl) return

  const enabled = parseBoolean(process.env.LEAVE_SCHEDULE_AUTO_DOWNLOAD_ENABLED)
  if (enabled === false) return

  const tzOffsetHours = parseIntEnv('LEAVE_SCHEDULE_AUTO_DOWNLOAD_TZ_OFFSET_HOURS', 8)
  const hour = Math.min(23, Math.max(0, parseIntEnv('LEAVE_SCHEDULE_AUTO_DOWNLOAD_HOUR', 6)))
  const minute = Math.min(59, Math.max(0, parseIntEnv('LEAVE_SCHEDULE_AUTO_DOWNLOAD_MINUTE', 0)))
  const runOnStartup = parseBoolean(process.env.LEAVE_SCHEDULE_AUTO_DOWNLOAD_RUN_ON_STARTUP) === true

  if (runOnStartup) {
    void runLeaveScheduleAutoDownload()
  } else {
    console.log('Leave schedule startup download skipped (set LEAVE_SCHEDULE_AUTO_DOWNLOAD_RUN_ON_STARTUP=true to enable).')
  }

  const scheduleNext = (): void => {
    const delayMs = computeNextDelayMs({ tzOffsetHours, hour, minute })
    setTimeout(() => {
      void runLeaveScheduleAutoDownload().finally(() => {
        scheduleNext()
      })
    }, delayMs)
  }

  scheduleNext()
}

if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true })
}

const uploadsDir = path.join(config.dataDir, 'uploads')
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => cb(null, file.originalname),
  }),
})

const openwaClient = new OpenwaClient(config.openwa)
const sessionService = new SessionService(openwaClient)
const messagingService = new MessagingService(openwaClient)
const directoryService = new DirectoryService(openwaClient)
const webhookService = new WebhookService(openwaClient)
const webhookCaptureStore = new WebhookCaptureStore(config.dataDir)
const ldapService = new LdapService()
const inboundCommandService = new InboundCommandService(
  messagingService,
  directoryService,
  ldapService,
  config.allowedPhoneNumbers
)
const dispatcher = startHelpdeskDispatcher({ messaging: messagingService })
const checkIp = createCheckIpMiddleware(config.allowedIps)

app.use(express.json({ limit: '20mb' }))
app.use(express.urlencoded({ extended: true, limit: '20mb' }))
app.use('/uploads', express.static(uploadsDir))

app.get('/', (_req, res) => {
  res.status(200).json({
    status: true,
    service: 'whatsapp-openwa-rebuild',
    phase: 'phase_0_bootstrap',
    openwaConfigured: openwaClient.isConfigured(),
  })
})

app.get('/health', (_req, res) => {
  res.status(200).json({ status: true })
})

registerMessageRoutes({
  app,
  upload,
  checkIp,
  messaging: messagingService,
  directory: directoryService,
})

registerChannelRoutes({
  app,
  checkIp,
  sessions: sessionService,
})

registerWebhookRoutes({
  app,
  checkIp,
  captureStore: webhookCaptureStore,
  webhookService,
  commandService: inboundCommandService,
  defaultWebhookUrl: config.openwa.webhookUrl,
  defaultWebhookSecret: config.openwa.webhookSecret,
})

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`)
  console.log(
    '[startup]',
    JSON.stringify({
      openwaConfigured: openwaClient.isConfigured(),
      webhookUrlConfigured: Boolean(config.openwa.webhookUrl),
      allowedIpCount: config.allowedIps.length,
      allowedPhoneCount: config.allowedPhoneNumbers.length,
      dataDir: config.dataDir,
      uploadsDir,
    })
  )
  startLeaveScheduleAutoDownloadScheduler()
})

function shutdown(): void {
  dispatcher.stop()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
