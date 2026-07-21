import fs from 'node:fs'
import OpenAI from 'openai'
import type { Express, Request, Response } from 'express'
import { body, validationResult } from 'express-validator'
import type { Multer } from 'multer'
import type { DirectoryService } from '../../channel/directoryService.js'
import type { MessagingService } from '../../channel/messagingService.js'
import {
  assignTechnicianToRequest,
  buildTicketLink,
  defineServiceCategory,
  downloadServiceDeskAttachment,
  updateRequest,
  viewRequest,
  type ServiceDeskAttachment,
  type ServiceDeskRequest,
} from '../../integrations/serviceDesk.js'
import { getContactByIctTechnicianName } from '../../integrations/technicianContacts.js'
import { findUserMobileByEmail } from '../../integrations/ldap.js'
import { storeTicketNotification } from '../../tickets/claimStore.js'
import { loadPreviousTicketState, saveTicketState } from '../../tickets/ticketStateStore.js'
import { ensureMentionJid, phoneNumberFormatter } from '../../../utils/phone.js'
import { extractPdfFirstPageText } from '../../../utils/pdf.js'

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

type GroupResolveResult =
  | { ok: true; chatId: string }
  | { ok: false; reason: 'not_found' | 'error'; message: string }

type WebhookBody = {
  id: string
  status: 'new' | 'updated'
  receiver: string
  receiver_type: string
  notify_requester_new?: string
  notify_requester_update?: string
  notify_requester_assign?: string
  notify_technician?: string
}

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

function isWebhookBody(input: unknown): input is WebhookBody {
  if (!input || typeof input !== 'object') return false
  const record = input as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    record.id.trim().length > 0 &&
    (record.status === 'new' || record.status === 'updated') &&
    typeof record.receiver === 'string' &&
    record.receiver.trim().length > 0 &&
    typeof record.receiver_type === 'string' &&
    record.receiver_type.trim().length > 0
  )
}

function shouldNotify(raw: string | undefined, defaultValue = false): boolean {
  if (!raw) return defaultValue
  return raw === 'true'
}

function normalizeReceiverJid(receiver: string): string {
  const trimmed = receiver.trim()
  if (trimmed.includes('@')) return trimmed
  return phoneNumberFormatter(trimmed)
}

function stripHtmlToText(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function truncateDescriptionFallback(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`
}

async function truncateDescription(args: { text: string; maxChars: number }): Promise<string> {
  const { text, maxChars } = args
  if (text.length <= maxChars) return text

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) return truncateDescriptionFallback(text, maxChars)

  const client = new OpenAI({ apiKey })
  const prompt =
    `Truncate the following ticket description to ${maxChars} characters or fewer. ` +
    `Preserve the key meaning. Do not add extra info. Output only the truncated text.\n\n` +
    text

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.2,
    })

    const content = response.choices[0]?.message?.content ?? ''
    const trimmed = content.trim()
    if (!trimmed) return truncateDescriptionFallback(text, maxChars)
    return trimmed.length <= maxChars ? trimmed : truncateDescriptionFallback(trimmed, maxChars)
  } catch {
    return truncateDescriptionFallback(text, maxChars)
  }
}

function renderKeyValueLines(rows: Array<{ label: string; value: string }>): string {
  return rows.map((row) => `${row.label}: ${row.value}`).join('\n')
}

function getRequesterLabel(request: ServiceDeskRequest): string {
  const name = request.requester?.name?.trim()
  const email = request.requester?.email_id?.trim()
  if (name && email) return `${name} (${email})`
  if (name) return name
  if (email) return email
  return 'Unknown requester'
}

async function resolveRequesterJid(request: ServiceDeskRequest): Promise<string | null> {
  const direct = request.requester?.mobile?.trim()
  if (direct) return phoneNumberFormatter(direct)

  const email = request.requester?.email_id?.trim()
  if (!email) return null

  const ldapMobile = await findUserMobileByEmail({ email })
  return ldapMobile ? phoneNumberFormatter(ldapMobile) : null
}

function renderTicketNewMessage(args: {
  requesterLabel: string
  createdDate: string
  ticketId: string
  category: string
  priority: string
  status: string
  subject: string
  description: string
  link: string
}): string {
  return `*New request from ${args.requesterLabel} on ${args.createdDate}*\n\n${renderKeyValueLines([
    { label: 'Ticket ID', value: args.ticketId },
    { label: 'Status', value: args.status },
    { label: 'Priority', value: args.priority },
    { label: 'Category', value: args.category },
    { label: 'Subject', value: args.subject },
    { label: 'Description', value: args.description },
    { label: 'Link', value: args.link },
  ])}`
}

function renderTicketUpdateMessage(args: {
  ticketId: string
  requesterLabel: string
  category: string
  priority: string
  status: string
  subject: string
  link: string
  changes: string[]
}): string {
  const base = renderKeyValueLines([
    { label: 'Ticket ID', value: args.ticketId },
    { label: 'Requester', value: args.requesterLabel },
    { label: 'Status', value: args.status },
    { label: 'Priority', value: args.priority },
    { label: 'Category', value: args.category },
    { label: 'Subject', value: args.subject },
  ])
  const changeLines = args.changes.length > 0 ? `\n\nChanges:\n${args.changes.map((item) => `- ${item}`).join('\n')}` : ''
  return `*Ticket Updated*\n\n${base}${changeLines}\n\nLink: ${args.link}`
}

function renderRequesterTicketCreatedMessage(args: {
  requesterLabel: string
  ticketId: string
  status: string
  priority: string
  category: string
  subject: string
  description: string
  link: string
}): string {
  return `Dear *${args.requesterLabel}*,\n\nYour request has been created successfully.\n\n${renderKeyValueLines([
    { label: 'Ticket ID', value: args.ticketId },
    { label: 'Status', value: args.status },
    { label: 'Priority', value: args.priority },
    { label: 'Category', value: args.category },
    { label: 'Subject', value: args.subject },
    { label: 'Description', value: args.description },
    { label: 'Link', value: args.link },
  ])}\n\nThank you.`
}

function renderRequesterTicketUpdatedMessage(args: {
  requesterLabel: string
  ticketId: string
  link: string
  changes: string[]
}): string {
  const changeLines = args.changes.length > 0 ? `\n\nChanges:\n${args.changes.map((item) => `- ${item}`).join('\n')}` : ''
  return `Dear *${args.requesterLabel}*,\n\nYour ticket has been updated.\n\nTicket ID: ${args.ticketId}${changeLines}\n\nLink: ${args.link}`
}

function renderRequesterTicketAssignedMessage(args: {
  requesterLabel: string
  ticketId: string
  assigneeName: string
  link: string
}): string {
  return `Dear *${args.requesterLabel}*,\n\nYour ticket has been assigned to *${args.assigneeName}*.\n\nTicket ID: ${args.ticketId}\n\nLink: ${args.link}`
}

function renderTicketAssignedToTechnicianMessage(args: {
  ticketId: string
  requesterLabel: string
  category: string
  priority: string
  status: string
  subject: string
  description: string
  link: string
}): string {
  return `*Ticket assigned to you*\n\n${renderKeyValueLines([
    { label: 'Ticket ID', value: args.ticketId },
    { label: 'Requester', value: args.requesterLabel },
    { label: 'Status', value: args.status },
    { label: 'Priority', value: args.priority },
    { label: 'Category', value: args.category },
    { label: 'Subject', value: args.subject },
    { label: 'Description', value: args.description },
    { label: 'Link', value: args.link },
  ])}`
}

function determineGroupByTechnicianRole(role: string): string {
  const normalized = role.toLowerCase()
  if (normalized.includes('document control')) return 'ICT Document Controller'
  if (normalized.includes('it field support')) return 'ICT Network and Infrastructure'
  return 'ICT System and Support'
}

function isClosedStatusName(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? ''
  if (!normalized) return false
  return ['resolved', 'closed', 'cancelled', 'canceled'].some((prefix) => {
    return normalized === prefix || normalized.startsWith(`${prefix} `) || normalized.startsWith(`${prefix}-`)
  })
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

  try {
    const groupId = await args.directory.resolveGroupIdByName(query)
    if (!groupId) return { ok: false, reason: 'not_found', message: `No group found with name: ${query}` }
    return { ok: true, chatId: groupId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: 'error', message }
  }
}

type GroupSendPrecheckResult = {
  receiverMeta: {
    isGroup: boolean
    groupAnnounce: boolean | null
    botInGroup: boolean | null
    botIsAdmin: boolean | null
    botUserId: string | null
  }
  blockError: string | null
}

function isGroupChatId(chatId: string): boolean {
  return chatId.endsWith('@g.us')
}

function normalizeKeywordText(value: string): string {
  return value
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parsePhonesEnv(name: string): string[] {
  const raw = process.env[name]
  if (!raw) return []
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

async function precheckGroupSend(args: { directory: DirectoryService; receiverJid: string }): Promise<GroupSendPrecheckResult> {
  if (!isGroupChatId(args.receiverJid)) {
    return {
      receiverMeta: { isGroup: false, groupAnnounce: null, botInGroup: null, botIsAdmin: null, botUserId: null },
      blockError: null,
    }
  }

  try {
    const meta = await args.directory.getGroupMetadata(args.receiverJid)
    const selfJid = await args.directory.getSelfJid()
    const participants = meta?.participants ?? null
    const groupAnnounce = meta?.announce ?? null
    const botUserId = selfJid
    const botParticipant = botUserId && participants ? participants.find((p) => p.id === botUserId) : undefined
    const botInGroup = botUserId && participants ? Boolean(botParticipant) : null
    const botIsAdmin = botParticipant ? botParticipant.isAdmin : botInGroup === false ? false : null

    const blockError =
      botInGroup === false
        ? 'Bot is not a member of the target group.'
        : groupAnnounce === true && botIsAdmin === false
          ? 'Target group is announce-only and bot is not admin.'
          : null

    return {
      receiverMeta: {
        isGroup: true,
        groupAnnounce,
        botInGroup,
        botIsAdmin,
        botUserId,
      },
      blockError,
    }
  } catch {
    return {
      receiverMeta: { isGroup: true, groupAnnounce: null, botInGroup: null, botIsAdmin: null, botUserId: null },
      blockError: null,
    }
  }
}

function isAttachment(value: unknown): value is ServiceDeskAttachment {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.name === 'string' && typeof record.content_url === 'string' && typeof record.content_type === 'string'
}

function isSrfPdfAttachmentHeuristic(args: {
  request: ServiceDeskRequest
  attachment: ServiceDeskAttachment
  pdfFirstPageText?: string
}): boolean {
  const contentType = args.attachment.content_type.toLowerCase()
  if (!contentType.startsWith('application/pdf')) return false

  const category = args.request.service_category?.name?.trim() ?? ''
  if (category.startsWith('14.')) return true

  const combined = normalizeKeywordText(
    `${args.request.subject ?? ''}\n${args.request.description ?? ''}\n${args.attachment.name ?? ''}\n${category}\n${args.pdfFirstPageText ?? ''}`
  )
  const needles = ['srf', 'service request form', 'approval', 'it service request form', 'form']
  return needles.some((needle) => combined.includes(normalizeKeywordText(needle)))
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (!raw) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

async function isSrfPdfAttachment(args: {
  request: ServiceDeskRequest
  attachment: ServiceDeskAttachment
  pdfFirstPageText?: string
}): Promise<boolean> {
  if (!args.attachment.content_type.toLowerCase().startsWith('application/pdf')) return false

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  const aiEnabled = parseBooleanEnv('SRF_DETECTION_AI_ENABLED', true)
  const model = process.env.SRF_DETECTION_AI_MODEL?.trim() || 'gpt-4o-mini'
  if (!apiKey || !aiEnabled) return isSrfPdfAttachmentHeuristic(args)

  const subject = (args.request.subject ?? '').trim()
  const description = stripHtmlToText(args.request.description ?? '')
  const category = (args.request.service_category?.name ?? '').trim()
  const attachmentName = (args.attachment.name ?? '').trim()

  const prompt =
    `Decide if this ticket attachment is an SRF (Service Request Form) that needs approval. ` +
    `Answer with ONLY "SRF" or "NOT_SRF".\n\n` +
    `Ticket subject: ${subject}\n` +
    `Ticket description: ${truncateDescriptionFallback(description, 800)}\n` +
    `Ticket category: ${category}\n` +
    `Attachment filename: ${attachmentName}\n` +
    `Attachment content-type: ${args.attachment.content_type}\n` +
    `PDF first page text (if available): ${truncateDescriptionFallback(args.pdfFirstPageText ?? '', 1200)}\n`

  try {
    const client = new OpenAI({ apiKey })
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 5,
      temperature: 0,
    })
    const content = (response.choices[0]?.message?.content ?? '').trim().toUpperCase()
    if (content === 'SRF') return true
    if (content === 'NOT_SRF') return false
    return isSrfPdfAttachmentHeuristic(args)
  } catch {
    return isSrfPdfAttachmentHeuristic(args)
  }
}

async function buildSrfApprovalMessage(args: {
  ticketId: string
  requesterLabel: string
  subject: string
  description: string
  attachmentName: string
  mentions: string[]
  pdfFirstPageText?: string
}): Promise<string> {
  const mentionTokens = args.mentions.map((jid) => `@${jid.split('@')[0] ?? jid}`)
  const mentionPrefix = mentionTokens.length > 0 ? `Pak ${mentionTokens.join(', ')}, ` : ''
  const fallback =
    `${mentionPrefix}terlampir SRF ${args.attachmentName}, dengan ticket ID ${args.ticketId} dari ${args.requesterLabel}, ` +
    `terkait "${args.subject}". Silahkan direview untuk approvalnya.`

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) return fallback

  const client = new OpenAI({ apiKey })
  const prompt =
    `Kamu adalah MTI ICT Helpdesk. Buat pesan singkat untuk approval SRF, tanpa menambah info di luar data. ` +
    `Sertakan ticket ID, requester, subject, ringkasan 1 kalimat isi SRF (kalau data cukup), dan instruksi minta review approval. Output hanya pesan final.\n\n` +
    `Ticket ID: ${args.ticketId}\nRequester: ${args.requesterLabel}\nSubject: ${args.subject}\nDescription: ${args.description}\nAttachment: ${args.attachmentName}\nPDF first page text: ${truncateDescriptionFallback(args.pdfFirstPageText ?? '', 1200)}\n` +
    `Mentions: ${mentionTokens.join(', ') || '-'}`

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.2,
    })
    const content = response.choices[0]?.message?.content ?? ''
    const trimmed = content.trim()
    if (!trimmed) return fallback
    return trimmed
  } catch {
    return fallback
  }
}

async function analyzeImageAttachment(args: {
  ticketId: string
  subject: string
  description: string
  attachmentName: string
  base64Image: string
}): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) return null

  const client = new OpenAI({ apiKey })
  const prompt =
    `Analyze the following ticket attachment in context.\n\n` +
    `Ticket ID: ${args.ticketId}\n` +
    `Subject: ${args.subject}\n` +
    `Description: ${args.description}\n` +
    `Attachment: ${args.attachmentName}\n\n` +
    `Output a concise summary of what the attachment shows and any key details relevant to troubleshooting.`

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${args.base64Image}` } },
          ],
        },
      ],
      max_tokens: 300,
      temperature: 0.4,
    })

    const content = response.choices[0]?.message?.content ?? ''
    const trimmed = content.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

async function handleAndSendAttachments(args: {
  request: ServiceDeskRequest
  receiverJid: string
  messaging: MessagingService
  allowSrfApproval: boolean
  requesterLabel: string
}): Promise<void> {
  const attachmentsRaw = Array.isArray(args.request.attachments) ? args.request.attachments : []
  const attachments = attachmentsRaw.filter(isAttachment)
  if (attachments.length < 1) return

  const subject = args.request.subject?.trim() ?? ''
  const description = stripHtmlToText(args.request.description ?? '')
  const descriptionTruncated = truncateDescriptionFallback(description, 500)
  const analysisLines: string[] = []
  const approverMentions = parsePhonesEnv('SRF_APPROVER_PHONES').map(ensureMentionJid)

  for (const attachment of attachments) {
    try {
      const buffer = await downloadServiceDeskAttachment({ contentUrl: attachment.content_url })
      const contentType = attachment.content_type
      const name = attachment.name

      if (contentType.startsWith('image/')) {
        const base64Image = buffer.toString('base64')
        const analysis = await analyzeImageAttachment({
          ticketId: args.request.id,
          subject,
          description: descriptionTruncated,
          attachmentName: name,
          base64Image,
        })

        if (analysis) {
          analysisLines.push(`- ${name}: ${analysis.replace(/\s+/g, ' ').trim()}`)
        }

        await args.messaging.sendImage({
          chatId: args.receiverJid,
          source: { kind: 'buffer', buffer, mimetype: contentType, filename: name },
          caption: analysis ? analysis : `Attachment: ${name}`,
        })

        continue
      }

      if (args.allowSrfApproval && contentType.toLowerCase().startsWith('application/pdf')) {
        const ticketId = args.request.id
        const previousState = await loadPreviousTicketState(ticketId)
        const alreadySent = new Set(previousState?.srfSentAttachmentUrls ?? [])
        const attachmentUrlKey = attachment.content_url.trim()
        if (attachmentUrlKey.length > 0 && alreadySent.has(attachmentUrlKey)) {
          analysisLines.push(`- ${name}: Skipped duplicate SRF send`)
          continue
        }

        let pdfFirstPageText: string | undefined
        try {
          const extracted = await extractPdfFirstPageText(buffer)
          pdfFirstPageText = extracted.trim().length > 0 ? extracted.trim() : undefined
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          analysisLines.push(`- ${name}: PDF text extraction failed (${message})`)
        }

        const isSrf = await isSrfPdfAttachment({ request: args.request, attachment, pdfFirstPageText })
        if (!isSrf) {
          await args.messaging.sendDocument({
            chatId: args.receiverJid,
            document: buffer,
            mimetype: contentType || 'application/pdf',
            fileName: name,
            caption: `Attachment: ${name}`,
          })
          continue
        }

        const approvalText = await buildSrfApprovalMessage({
          ticketId: args.request.id,
          requesterLabel: args.requesterLabel,
          subject,
          description: descriptionTruncated,
          attachmentName: name,
          mentions: approverMentions,
          pdfFirstPageText,
        })
        await args.messaging.sendText({
          chatId: args.receiverJid,
          text: approvalText,
          mentions: approverMentions,
        })
        await args.messaging.sendDocument({
          chatId: args.receiverJid,
          document: buffer,
          mimetype: contentType || 'application/pdf',
          fileName: name,
          caption: `SRF: ${name}`,
          mentions: approverMentions,
        })

        if (attachmentUrlKey.length > 0) {
          const merged = [...alreadySent, attachmentUrlKey].slice(-40)
          await saveTicketState(ticketId, {
            ...(previousState ?? {}),
            srfSentAttachmentUrls: merged,
          })
        }
        continue
      }

      await args.messaging.sendDocument({
        chatId: args.receiverJid,
        document: buffer,
        mimetype: contentType || 'application/octet-stream',
        fileName: name,
        caption: `Attachment: ${name}`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      analysisLines.push(`- ${attachment.name}: Error handling attachment (${message})`)
    }
  }

  const filtered = analysisLines.map((line) => line.trim()).filter((line) => line.length > 0)
  if (filtered.length > 0) {
    await args.messaging.sendText({
      chatId: args.receiverJid,
      text: `*Attachment Analysis*\n${filtered.join('\n')}`,
    })
  }
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

        const precheck = await precheckGroupSend({ directory: deps.directory, receiverJid: resolved.chatId })
        if (precheck.blockError) {
          res.status(409).json({ status: false, message: precheck.blockError, receiverMeta: precheck.receiverMeta })
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

  deps.app.post('/webhook', deps.checkIp, async (req: Request, res: Response) => {
    if (!isWebhookBody(req.body)) {
      res.status(400).json({ error: 'Invalid payload' })
      return
    }

    try {
      const payload = req.body
      const request = await viewRequest(payload.id)
      if (!request) {
        res.status(404).json({ error: 'Request not found' })
        return
      }

      const receiverJid = normalizeReceiverJid(payload.receiver)
      const requesterLabel = getRequesterLabel(request)
      const ticketStatus = request.status?.name?.trim() || 'N/A'
      const subject = request.subject?.trim() || 'No subject'
      const createdDate = request.created_time?.display_value?.trim() || 'N/A'
      const descriptionPlain = stripHtmlToText(request.description ?? '')
      const truncatedDescription = await truncateDescription({ text: descriptionPlain, maxChars: 200 })
      const ticketLink = buildTicketLink(request.id)
      const requesterJid = await resolveRequesterJid(request)
      const receiverPrecheck = await precheckGroupSend({ directory: deps.directory, receiverJid })

      if (payload.status === 'new') {
        let categoryForMessage = request.service_category?.name?.trim() || 'N/A'
        let priorityForMessage = request.priority?.name?.trim() || 'N/A'
        const updateArgs: {
          templateId?: string
          templateName?: string
          isServiceTemplate?: boolean
          serviceCategory?: string
          priority?: string
        } = {}

        if ((request.template?.id ?? '') !== '305') {
          updateArgs.templateId = '305'
          updateArgs.templateName = 'Submit a New Request'
          updateArgs.isServiceTemplate = false
        }
        if (categoryForMessage === 'N/A') {
          const suggestedCategory = await defineServiceCategory(request.id)
          if (suggestedCategory) updateArgs.serviceCategory = suggestedCategory
        }
        if (priorityForMessage === 'N/A') {
          updateArgs.priority = 'Low'
        }

        if (Object.keys(updateArgs).length > 0) {
          const updateResult = await updateRequest(request.id, updateArgs)
          if (!updateResult.success) {
            console.warn(`Ticket update (new) failed for ${request.id}: ${updateResult.message}`)
          } else {
            const refreshed = await viewRequest(request.id)
            if (refreshed?.service_category?.name?.trim()) categoryForMessage = refreshed.service_category.name.trim()
            else if (updateArgs.serviceCategory) categoryForMessage = updateArgs.serviceCategory
            if (refreshed?.priority?.name?.trim()) priorityForMessage = refreshed.priority.name.trim()
            else if (updateArgs.priority) priorityForMessage = updateArgs.priority
          }
        }

        const messageText = renderTicketNewMessage({
          requesterLabel,
          createdDate,
          ticketId: request.id,
          category: categoryForMessage,
          priority: priorityForMessage,
          status: ticketStatus,
          subject,
          description: truncatedDescription,
          link: ticketLink,
        })

        let receiverSent = false
        let receiverError: string | null = null
        if (receiverPrecheck.blockError) {
          receiverError = receiverPrecheck.blockError
        } else {
          try {
            const sent = await deps.messaging.sendText({ chatId: receiverJid, text: messageText })
            receiverSent = true
            if (sent.messageId) {
              await storeTicketNotification({
                ticketId: request.id,
                remoteJid: sent.remoteJid ?? receiverJid,
                messageId: sent.messageId,
              })
            }
          } catch (error) {
            receiverError = error instanceof Error ? error.message : String(error)
            console.error(`Receiver notify (new) failed for ${request.id}: ${receiverError}`)
          }
        }

        if (receiverSent) {
          await handleAndSendAttachments({
            request,
            receiverJid,
            messaging: deps.messaging,
            allowSrfApproval: true,
            requesterLabel,
          })
        }

        if (shouldNotify(payload.notify_requester_new, true) && requesterJid) {
          const requesterMessage = renderRequesterTicketCreatedMessage({
            requesterLabel,
            ticketId: request.id,
            status: ticketStatus,
            priority: priorityForMessage,
            category: categoryForMessage,
            subject,
            description: truncatedDescription,
            link: ticketLink,
          })

          try {
            await deps.messaging.sendText({ chatId: requesterJid, text: requesterMessage })
          } catch (error) {
            console.error(
              `Requester notify (new) failed for ${request.id}: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        }

        const stateSnapshot = await loadPreviousTicketState(request.id)
        await saveTicketState(request.id, {
          ...(stateSnapshot ?? {}),
          technician: request.udf_fields?.udf_pick_601 ?? undefined,
          ticketStatus,
          priority: priorityForMessage,
        })

        res
          .status(200)
          .json({ status: true, message: 'Webhook processed', receiverSent, receiverError, receiverMeta: receiverPrecheck.receiverMeta })
        return
      }

      let categoryForMessage = request.service_category?.name?.trim() || 'N/A'
      let priorityForMessage = request.priority?.name?.trim() || 'N/A'
      const updateArgs: { serviceCategory?: string; priority?: string } = {}
      if (categoryForMessage === 'N/A') {
        const suggestedCategory = await defineServiceCategory(request.id)
        if (suggestedCategory) updateArgs.serviceCategory = suggestedCategory
      }
      if (priorityForMessage === 'N/A') {
        updateArgs.priority = 'Low'
      }

      if (Object.keys(updateArgs).length > 0) {
        const updateResult = await updateRequest(request.id, updateArgs)
        if (!updateResult.success) {
          console.warn(`Ticket update (updated) failed for ${request.id}: ${updateResult.message}`)
        } else {
          const refreshed = await viewRequest(request.id)
          if (refreshed?.service_category?.name?.trim()) categoryForMessage = refreshed.service_category.name.trim()
          else if (updateArgs.serviceCategory) categoryForMessage = updateArgs.serviceCategory
          if (refreshed?.priority?.name?.trim()) priorityForMessage = refreshed.priority.name.trim()
          else if (updateArgs.priority) priorityForMessage = updateArgs.priority
        }
      }

      const previousState = await loadPreviousTicketState(request.id)
      const currentTechnician = request.udf_fields?.udf_pick_601?.trim()
      let ticketStatusForMessage = ticketStatus

      const shouldAutoInProgress =
        !isClosedStatusName(ticketStatusForMessage) &&
        !isClosedStatusName(previousState?.ticketStatus) &&
        previousState !== null &&
        Boolean(currentTechnician) &&
        currentTechnician !== 'ICT Helpdesk' &&
        previousState.technician !== currentTechnician

      if (shouldAutoInProgress && ticketStatusForMessage !== 'In Progress') {
        const updateResult = await updateRequest(request.id, { status: 'In Progress' })
        if (!updateResult.success) {
          console.warn(`Ticket status update failed for ${request.id}: ${updateResult.message}`)
        } else {
          const refreshed = await viewRequest(request.id)
          ticketStatusForMessage = refreshed?.status?.name?.trim() || 'In Progress'
        }
      }

      const changes: string[] = []
      if (previousState?.ticketStatus && previousState.ticketStatus !== ticketStatusForMessage) {
        changes.push(`Status: ${previousState.ticketStatus} -> ${ticketStatusForMessage}`)
      } else {
        changes.push(`Status: ${ticketStatusForMessage}`)
      }
      if (previousState?.priority && previousState.priority !== priorityForMessage) {
        changes.push(`Priority: ${previousState.priority} -> ${priorityForMessage}`)
      } else {
        changes.push(`Priority: ${priorityForMessage}`)
      }
      if (previousState?.technician && previousState.technician !== (currentTechnician ?? '')) {
        changes.push(`Technician: ${previousState.technician} -> ${currentTechnician ?? 'Unassigned'}`)
      } else if (currentTechnician) {
        changes.push(`Technician: ${currentTechnician}`)
      }

      let receiverSent = false
      let receiverError: string | null = null
      if (receiverPrecheck.blockError) {
        receiverError = receiverPrecheck.blockError
      } else {
        try {
          await deps.messaging.sendText({
            chatId: receiverJid,
            text: renderTicketUpdateMessage({
              ticketId: request.id,
              requesterLabel,
              category: categoryForMessage,
              priority: priorityForMessage,
              status: ticketStatusForMessage,
              subject,
              link: ticketLink,
              changes,
            }),
          })
          receiverSent = true
        } catch (error) {
          receiverError = error instanceof Error ? error.message : String(error)
          console.error(`Receiver notify (updated) failed for ${request.id}: ${receiverError}`)
        }
      }

      if (receiverSent) {
        await handleAndSendAttachments({
          request,
          receiverJid,
          messaging: deps.messaging,
          allowSrfApproval: false,
          requesterLabel,
        })
      }

      if (shouldNotify(payload.notify_requester_update) && requesterJid) {
        try {
          await deps.messaging.sendText({
            chatId: requesterJid,
            text: renderRequesterTicketUpdatedMessage({
              requesterLabel,
              ticketId: request.id,
              link: ticketLink,
              changes,
            }),
          })
        } catch (error) {
          console.error(
            `Requester notify (updated) failed for ${request.id}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }

      if (
        currentTechnician &&
        currentTechnician !== 'ICT Helpdesk' &&
        previousState?.technician !== currentTechnician &&
        shouldNotify(payload.notify_technician)
      ) {
        const technicianContact = getContactByIctTechnicianName(currentTechnician)
        if (technicianContact) {
          const assignResult = await assignTechnicianToRequest({
            requestId: request.id,
            groupName: determineGroupByTechnicianRole(technicianContact.technician),
            technicianName: technicianContact.technician,
          })
          if (!assignResult.success) {
            console.warn(`ServiceDesk assign technician failed for ${request.id}: ${assignResult.message}`)
          }

          try {
            await deps.messaging.sendText({
              chatId: phoneNumberFormatter(technicianContact.phone),
              text: renderTicketAssignedToTechnicianMessage({
                ticketId: request.id,
                requesterLabel,
                category: categoryForMessage,
                priority: priorityForMessage,
                status: ticketStatusForMessage,
                subject,
                description: truncatedDescription,
                link: ticketLink,
              }),
            })
          } catch (error) {
            console.error(
              `Technician notify failed for ${request.id}: ${error instanceof Error ? error.message : String(error)}`
            )
          }

          if (shouldNotify(payload.notify_requester_assign) && requesterJid) {
            try {
              await deps.messaging.sendText({
                chatId: requesterJid,
                text: renderRequesterTicketAssignedMessage({
                  requesterLabel,
                  ticketId: request.id,
                  assigneeName: technicianContact.name,
                  link: ticketLink,
                }),
              })
            } catch (error) {
              console.error(
                `Requester assign notify failed for ${request.id}: ${error instanceof Error ? error.message : String(error)}`
              )
            }
          }
        }
      }

      await saveTicketState(request.id, {
        ...(previousState ?? {}),
        technician: currentTechnician,
        ticketStatus: ticketStatusForMessage,
        priority: priorityForMessage,
      })

      res
        .status(200)
        .json({ status: true, message: 'Webhook processed', receiverSent, receiverError, receiverMeta: receiverPrecheck.receiverMeta })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`ServiceDesk webhook failed: ${message}`)
      res.status(500).json({ status: false, message })
    }
  })
}
