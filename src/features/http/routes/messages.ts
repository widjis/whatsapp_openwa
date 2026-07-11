import fs from 'node:fs'
import type { Express, Request, Response } from 'express'
import { body, validationResult } from 'express-validator'
import type { Multer } from 'multer'
import type { DirectoryService } from '../../channel/directoryService.js'
import type { MessagingService } from '../../channel/messagingService.js'
import { ensureMentionJid, phoneNumberFormatter } from '../../../utils/phone.js'

type RegisterMessageRoutesDeps = {
  app: Express
  upload: Multer
  checkIp: (req: Request, res: Response, next: () => void) => void
  messaging: MessagingService
  directory: DirectoryService
}

type SendMessageBody = {
  number: string
  message?: string
  imageUrl?: string
  imageBuffer?: string
}

type SendBulkMessageBody = {
  message: string
  numbers: string[]
  minDelay?: number
  maxDelay?: number
}

type SendGroupMessageBody = {
  id?: string
  name?: string
  message?: string
  mention?: string
}

type UploadedFile = {
  path: string
  originalname: string
  mimetype?: string
}

type GroupCacheEntry = {
  id: string
  subject: string
  subjectLower: string
}

type GroupResolveResult =
  | { ok: true; chatId: string }
  | { ok: false; reason: 'not_found' | 'error'; message: string }

let groupCache:
  | {
      fetchedAtMs: number
      entries: GroupCacheEntry[]
    }
  | null = null

function pickUploadedFile(files: unknown, fieldName: string): UploadedFile | undefined {
  if (!files || typeof files !== 'object') return undefined
  const entry = (files as Record<string, unknown>)[fieldName]
  if (!Array.isArray(entry) || entry.length < 1) return undefined

  const first = entry[0]
  if (!first || typeof first !== 'object') return undefined

  const record = first as Record<string, unknown>
  if (typeof record.path !== 'string' || typeof record.originalname !== 'string') return undefined

  return {
    path: record.path,
    originalname: record.originalname,
    mimetype: typeof record.mimetype === 'string' ? record.mimetype : undefined,
  }
}

function parseMentionedJids(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim().length < 1) return []

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>
          if (typeof record.jid === 'string') return record.jid
          if (typeof record.phone === 'string') return record.phone
        }
        return null
      })
      .filter((item): item is string => Boolean(item))
      .map(ensureMentionJid)
  } catch {
    return []
  }
}

function getValidationError(res: Response, req: Request): boolean {
  const errors = validationResult(req).formatWith((error) => error.msg)
  if (!errors.isEmpty()) {
    res.status(422).json({ status: false, errors: errors.mapped() })
    return true
  }
  return false
}

function resolveDocumentMimeType(file: UploadedFile): string {
  if (file.originalname.toLowerCase().endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }
  if (file.originalname.toLowerCase().endsWith('.pdf')) return 'application/pdf'
  return file.mimetype ?? 'application/octet-stream'
}

async function fetchGroupCache(directory: DirectoryService) {
  const groups = await directory.listGroups()
  const entries = groups.map((group) => ({
    id: group.id,
    subject: group.subject,
    subjectLower: group.subject.toLowerCase(),
  }))

  groupCache = {
    fetchedAtMs: Date.now(),
    entries,
  }

  return groupCache
}

async function resolveGroupChatId(args: {
  directory: DirectoryService
  id?: string
  name?: string
}): Promise<GroupResolveResult> {
  const id = args.id?.trim()
  if (id && id.includes('@g.us')) return { ok: true, chatId: id }
  if (id && /^\d+$/.test(id)) return { ok: true, chatId: `${id}@g.us` }

  const query = (args.name ?? '').trim()
  if (!query) return { ok: false, reason: 'not_found', message: 'Missing group id or name' }

  const ttlMs = 5 * 60 * 1000
  const currentCache = groupCache && Date.now() - groupCache.fetchedAtMs <= ttlMs ? groupCache : await fetchGroupCache(args.directory)
  const match = currentCache.entries.find((entry) => entry.subjectLower.includes(query.toLowerCase()))
  if (!match) return { ok: false, reason: 'not_found', message: `No group found with name: ${query}` }
  return { ok: true, chatId: match.id }
}

export function registerMessageRoutes(deps: RegisterMessageRoutesDeps) {
  deps.app.post(
    '/send-message',
    deps.checkIp,
    deps.upload.single('image'),
    [
      body('number').trim().notEmpty().withMessage('Number cannot be empty'),
      body('message')
        .optional()
        .isString()
        .withMessage('Message must be text'),
      body('imageBuffer')
        .optional()
        .isString()
        .withMessage('imageBuffer must be a base64 string'),
    ],
    async (req: Request, res: Response) => {
      if (getValidationError(res, req)) return

      const body = req.body as SendMessageBody
      const jid = phoneNumberFormatter(body.number)

      try {
        const isRegistered = await deps.directory.checkRegisteredNumber(jid)
        if (!isRegistered) {
          res.status(422).json({ status: false, message: 'The number is not registered' })
          return
        }

        if (req.file) {
          const fileBuffer = await fs.promises.readFile(req.file.path)
          try {
            const response = await deps.messaging.sendImage({
              chatId: jid,
              source: { kind: 'buffer', buffer: fileBuffer, mimetype: req.file.mimetype, filename: req.file.originalname },
              caption: body.message ?? '',
            })
            res.status(200).json({ status: true, response })
          } finally {
            await fs.promises.unlink(req.file.path).catch(() => undefined)
          }
          return
        }

        if (body.imageBuffer) {
          const imageBuffer = Buffer.from(body.imageBuffer, 'base64')
          const response = await deps.messaging.sendImage({
            chatId: jid,
            source: { kind: 'buffer', buffer: imageBuffer },
            caption: body.message ?? '',
          })
          res.status(200).json({ status: true, response })
          return
        }

        if (body.imageUrl) {
          const response = await deps.messaging.sendImage({
            chatId: jid,
            source: { kind: 'url', url: body.imageUrl },
            caption: body.message ?? '',
          })
          res.status(200).json({ status: true, response })
          return
        }

        const response = await deps.messaging.sendText({
          chatId: jid,
          text: body.message ?? '',
        })
        res.status(200).json({ status: true, response })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        res.status(500).json({ status: false, message })
      }
    }
  )

  deps.app.post('/send-bulk-message', deps.checkIp, async (req, res) => {
    const body = req.body as SendBulkMessageBody
    if (!body.message || !Array.isArray(body.numbers) || body.numbers.length < 1) {
      res.status(400).json({ status: false, message: 'Message and numbers are required.' })
      return
    }

    try {
      const response = await deps.messaging.sendBulk({
        messages: body.numbers.map((number) => ({
          chatId: phoneNumberFormatter(number),
          text: body.message,
        })),
        delayBetweenMessages: body.minDelay,
        randomizeDelay: typeof body.maxDelay === 'number' && typeof body.minDelay === 'number' ? body.maxDelay > body.minDelay : true,
      })
      res.status(202).json({ status: true, response })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ status: false, message })
    }
  })

  deps.app.post(
    '/send-group-message',
    deps.checkIp,
    deps.upload.fields([
      { name: 'document', maxCount: 1 },
      { name: 'image', maxCount: 1 },
    ]),
    [
      body('id').optional().isString(),
      body('name').optional().isString(),
      body('message').optional().isString(),
    ],
    async (req: Request, res: Response) => {
      if (getValidationError(res, req)) return

      const body = req.body as SendGroupMessageBody
      const mentionedJids = parseMentionedJids(body.mention)

      try {
        const resolved = await resolveGroupChatId({
          directory: deps.directory,
          id: body.id,
          name: body.name,
        })

        if (!resolved.ok) {
          res.status(422).json({ status: false, message: resolved.message })
          return
        }

        const files = (req as Request & { files?: unknown }).files
        const document = pickUploadedFile(files, 'document')
        const image = pickUploadedFile(files, 'image')

        if (document) {
          const buffer = await fs.promises.readFile(document.path)
          try {
            const response = await deps.messaging.sendDocument({
              chatId: resolved.chatId,
              document: buffer,
              mimetype: resolveDocumentMimeType(document),
              fileName: document.originalname,
              caption: body.message ?? '',
              mentions: mentionedJids,
            })
            res.status(200).json({ status: true, response })
          } finally {
            await fs.promises.unlink(document.path).catch(() => undefined)
          }
          return
        }

        if (image) {
          const buffer = await fs.promises.readFile(image.path)
          try {
            const response = await deps.messaging.sendImage({
              chatId: resolved.chatId,
              source: { kind: 'buffer', buffer, mimetype: image.mimetype, filename: image.originalname },
              caption: body.message ?? '',
              mentions: mentionedJids,
            })
            res.status(200).json({ status: true, response })
          } finally {
            await fs.promises.unlink(image.path).catch(() => undefined)
          }
          return
        }

        const response = await deps.messaging.sendText({
          chatId: resolved.chatId,
          text: body.message ?? 'Hello',
          mentions: mentionedJids,
        })
        res.status(200).json({ status: true, response })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        res.status(500).json({ status: false, message })
      }
    }
  )
}
