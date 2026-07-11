import dotenv from 'dotenv'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import multer from 'multer'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config/env.js'
import { OpenwaClient } from './features/channel/openwaClient.js'
import { SessionService } from './features/channel/sessionService.js'
import { MessagingService } from './features/channel/messagingService.js'
import { DirectoryService } from './features/channel/directoryService.js'
import { WebhookCaptureStore, WebhookService } from './features/channel/webhookService.js'
import { InboundCommandService } from './features/inbound/commandService.js'
import { createCheckIpMiddleware } from './features/http/middleware/checkIp.js'
import { registerMessageRoutes } from './features/http/routes/messages.js'
import { registerChannelRoutes } from './features/http/routes/channel.js'
import { registerWebhookRoutes } from './features/http/routes/webhooks.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const config = loadConfig(projectRoot)
const app = express()

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
const inboundCommandService = new InboundCommandService(messagingService, config.allowedPhoneNumbers)
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
})
