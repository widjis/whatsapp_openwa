import type { OpenwaClient } from '../channel/openwaClient.js'
import type { InboundMessageEvent } from '../channel/eventNormalizer.js'
import { phoneNumberFormatter, normalizePhoneDigits } from '../../utils/phone.js'

type OpenwaMessage = {
  id?: string
  waMessageId?: string | null
  chatId?: string
  from?: string
  body?: string
  type?: string
  direction?: string
  timestamp?: number
  createdAt?: string
}

type OpenwaMessageHistoryResponse = {
  messages?: OpenwaMessage[]
  total?: number
}

type CommandService = {
  processInboundMessage(event: InboundMessageEvent): Promise<{ handled: boolean; commandName?: string }>
}

type N8nService = {
  processInboundMessage(event: InboundMessageEvent): Promise<{ handled: boolean; replyText?: string }>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeHistoryResponse(value: unknown): OpenwaMessageHistoryResponse | null {
  const record = asRecord(value)
  if (!record) return null

  const messages = Array.isArray(record.messages) ? (record.messages as OpenwaMessage[]) : null
  return { messages: messages ?? undefined, total: asNumber(record.total) ?? undefined }
}

function normalizeMessage(value: unknown): OpenwaMessage | null {
  const record = asRecord(value)
  if (!record) return null

  return {
    id: asString(record.id) ?? undefined,
    waMessageId: typeof record.waMessageId === 'string' ? record.waMessageId : record.waMessageId === null ? null : undefined,
    chatId: asString(record.chatId) ?? undefined,
    from: asString(record.from) ?? undefined,
    body: asString(record.body) ?? undefined,
    type: asString(record.type) ?? undefined,
    direction: asString(record.direction) ?? undefined,
    timestamp: asNumber(record.timestamp) ?? undefined,
    createdAt: asString(record.createdAt) ?? undefined,
  }
}

function isGroupChat(chatId: string): boolean {
  return chatId.endsWith('@g.us')
}

function buildInboundEvent(args: {
  sessionId: string | null
  message: OpenwaMessage
}): InboundMessageEvent | null {
  const chatId = args.message.chatId
  const body = args.message.body
  const from = args.message.from

  if (!chatId || !body || !from) return null

  const senderId = phoneNumberFormatter(from)
  const occurredAt =
    typeof args.message.createdAt === 'string' && args.message.createdAt.trim().length > 0
      ? args.message.createdAt
      : new Date(((args.message.timestamp ?? Math.floor(Date.now() / 1000)) * 1000)).toISOString()

  return {
    provider: 'openwa',
    eventType: 'message.received',
    sessionId: args.sessionId,
    chatId,
    senderId,
    senderPhone: normalizePhoneDigits(senderId) || null,
    isGroup: isGroupChat(chatId),
    messageId: args.message.waMessageId ?? args.message.id ?? null,
    text: body,
    occurredAt,
    raw: args.message,
  }
}

export function startOpenwaInboundPolling(args: {
  client: OpenwaClient
  commandService: CommandService
  n8n?: N8nService
  intervalMs: number
  limit: number
  chatId?: string
}): { stop: () => void } {
  let stopped = false
  let inFlight = false
  const seen = new Set<string>()
  let lastIncomingTs = 0
  let consecutiveErrors = 0
  let nextAllowedAtMs = 0
  let lastErrorMessage: string | null = null
  let lastErrorLogAtMs = 0

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return
    if (Date.now() < nextAllowedAtMs) return
    inFlight = true
    try {
      const sessionId = await args.client.resolveSessionId().catch(() => null)
      if (!sessionId) return

      const query = new URLSearchParams()
      query.set('limit', String(Math.max(1, Math.min(200, args.limit))))
      if (args.chatId) query.set('chatId', args.chatId)

      const payload = await args.client.get<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/messages?${query}`)
      const normalized = normalizeHistoryResponse(payload)
      const rawMessages = normalized?.messages ?? []

      const messages = rawMessages
        .map((message) => normalizeMessage(message))
        .filter((message): message is OpenwaMessage => Boolean(message))
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))

      for (const message of messages) {
        if (stopped) break
        if (message.direction !== 'incoming') continue
        if (message.type && message.type !== 'text') continue
        if (typeof message.timestamp === 'number' && message.timestamp <= lastIncomingTs) continue

        const stableId = message.id ?? message.waMessageId ?? null
        if (!stableId) continue
        if (seen.has(stableId)) continue
        seen.add(stableId)

        const event = buildInboundEvent({ sessionId, message })
        if (!event) continue

        const textPreview = event.text.replace(/\s+/g, ' ').slice(0, 120)
        console.log('[polling:incoming]', JSON.stringify({ chatId: event.chatId, senderId: event.senderId, messageId: event.messageId, textPreview }))

        const result = await args.commandService.processInboundMessage(event)
        console.log('[polling:processed]', JSON.stringify({ handled: result.handled, commandName: result.commandName ?? null }))

        if (!result.handled && args.n8n) {
          const n8nResult = await args.n8n.processInboundMessage(event)
          console.log('[polling:n8n]', JSON.stringify({ handled: n8nResult.handled }))
        }

        if (typeof message.timestamp === 'number') {
          lastIncomingTs = Math.max(lastIncomingTs, message.timestamp)
        }

        if (seen.size > 5000) {
          const items = Array.from(seen)
          seen.clear()
          for (const item of items.slice(items.length - 2500)) {
            seen.add(item)
          }
        }
      }

      consecutiveErrors = 0
      nextAllowedAtMs = 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      consecutiveErrors = Math.min(20, consecutiveErrors + 1)
      const backoffMs = Math.min(30_000, Math.max(1_000, 1_000 * Math.pow(2, consecutiveErrors - 1)))
      nextAllowedAtMs = Date.now() + backoffMs

      const shouldLog = message !== lastErrorMessage || Date.now() - lastErrorLogAtMs >= 10_000
      if (shouldLog) {
        console.error('[polling:error]', JSON.stringify({ message, consecutiveErrors, backoffMs }))
        lastErrorMessage = message
        lastErrorLogAtMs = Date.now()
      }
    } finally {
      inFlight = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, Math.max(500, args.intervalMs))

  void tick()

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
