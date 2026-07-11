type UnknownRecord = Record<string, unknown>

export type InboundMessageEvent = {
  provider: 'openwa'
  eventType: 'message.received'
  sessionId: string | null
  chatId: string
  senderId: string
  senderPhone: string | null
  isGroup: boolean
  messageId: string | null
  text: string
  occurredAt: string
  raw: unknown
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

function extractDigits(value: string | null): string | null {
  if (!value) return null
  const localPart = value.split('@')[0] ?? value
  const digits = localPart.replace(/[^\d]/g, '')
  return digits || null
}

function readTextFromMessageContainer(value: unknown): string | null {
  const record = asRecord(value)
  if (!record) return null

  return firstString(
    record.text,
    record.body,
    record.conversation,
    asRecord(record.extendedTextMessage)?.text,
    asRecord(record.imageMessage)?.caption,
    asRecord(record.videoMessage)?.caption,
    asRecord(record.documentMessage)?.caption
  )
}

function extractPayloadEnvelope(raw: unknown): { envelope: UnknownRecord; payload: UnknownRecord } | null {
  const envelope = asRecord(raw)
  if (!envelope) return null

  const directPayload =
    asRecord(envelope.payload) ??
    asRecord(envelope.data) ??
    asRecord(envelope.message) ??
    asRecord(envelope.eventData) ??
    envelope

  return { envelope, payload: directPayload }
}

export function normalizeInboundMessageEvent(raw: unknown): InboundMessageEvent | null {
  const extracted = extractPayloadEnvelope(raw)
  if (!extracted) return null

  const eventName = firstString(extracted.envelope.event, extracted.envelope.type, extracted.payload.event, extracted.payload.type)
  if (eventName !== 'message.received') return null

  const message = asRecord(extracted.payload.message)
  const key = asRecord(message?.key)

  const chatId = firstString(
    extracted.payload.chatId,
    extracted.payload.remoteJid,
    extracted.payload.from,
    extracted.payload.to,
    message?.chatId,
    key?.remoteJid
  )

  const senderId = firstString(
    extracted.payload.senderId,
    extracted.payload.author,
    extracted.payload.participant,
    extracted.payload.from,
    message?.senderId,
    key?.participant,
    key?.remoteJid
  )

  const text = firstString(
    extracted.payload.text,
    extracted.payload.body,
    extracted.payload.messageText,
    readTextFromMessageContainer(extracted.payload.message),
    readTextFromMessageContainer(extracted.payload)
  )

  if (!chatId || !senderId || !text) return null

  const occurredAt =
    firstString(
      extracted.payload.occurredAt,
      extracted.payload.timestamp,
      extracted.payload.ts,
      extracted.envelope.occurredAt,
      extracted.envelope.timestamp
    ) ?? new Date().toISOString()

  const messageId = firstString(
    extracted.payload.messageId,
    extracted.payload.id,
    message?.messageId,
    key?.id
  )

  return {
    provider: 'openwa',
    eventType: 'message.received',
    sessionId: firstString(extracted.envelope.sessionId, extracted.envelope.session_id, extracted.payload.sessionId, extracted.payload.session_id),
    chatId,
    senderId,
    senderPhone: extractDigits(senderId),
    isGroup: chatId.endsWith('@g.us'),
    messageId,
    text,
    occurredAt,
    raw,
  }
}
