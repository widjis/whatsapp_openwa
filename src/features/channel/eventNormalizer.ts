import { normalizePhoneDigits, phoneNumberFormatter } from '../../utils/phone.js'

type UnknownRecord = Record<string, unknown>

export type InboundMessageEvent = {
  provider: 'openwa'
  eventType: 'message.received'
  sessionId: string | null
  chatId: string
  senderId: string
  senderPhone: string | null
  pushName: string | null
  isGroup: boolean
  messageId: string | null
  text: string
  messageType: string | null
  mentionedJids: string[]
  occurredAt: string
  raw: unknown
}

export type ReactionEvent = {
  provider: 'openwa'
  eventType: 'message.reaction'
  sessionId: string | null
  chatId: string
  messageId: string
  senderId: string
  senderPhone: string | null
  emoji: string | null
  removed: boolean
  occurredAt: string
  raw: unknown
}

export type PresenceUpdateEvent = {
  provider: 'openwa'
  eventType: 'presence.update'
  sessionId: string | null
  chatId: string
  isGroup: boolean
  updates: Array<{
    participantId: string
    participantPhone: string | null
    presence: string
  }>
  occurredAt: string
  raw: unknown
}

export type NormalizedOpenwaEvent = InboundMessageEvent | ReactionEvent | PresenceUpdateEvent

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

function extractStablePhone(rawPhone: unknown, senderId: string | null): string | null {
  if (typeof rawPhone === 'string' && rawPhone.trim().length > 0) {
    return normalizePhoneDigits(rawPhone) || null
  }

  if (!senderId) return null
  const senderDigits = extractDigits(senderId)
  const digits = normalizePhoneDigits(senderDigits ?? '')
  return digits || null
}

function normalizeSenderId(senderId: string): string {
  if (senderId.endsWith('@g.us') || senderId.endsWith('@lid')) return senderId
  const senderDigits = extractDigits(senderId)
  const digits = normalizePhoneDigits(senderDigits ?? '')
  if (digits) return `${digits}@c.us`
  if (!senderId.includes('@')) return phoneNumberFormatter(senderId)
  return senderId
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

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
}

function readMentionedJids(value: unknown): string[] {
  const record = asRecord(value)
  if (!record) return []
  return (
    asStringArray(record.mentionedJid) ||
    asStringArray(record.mentionedJids) ||
    asStringArray(record.mentions) ||
    asStringArray(asRecord(record.contextInfo)?.mentionedJid) ||
    asStringArray(asRecord(record.contextInfo)?.mentionedJids) ||
    asStringArray(asRecord(record.contextInfo)?.mentions)
  )
}

function inferMessageType(payload: UnknownRecord, message: UnknownRecord | null): string | null {
  const direct = firstString(payload.messageType, payload.type)
  if (direct && direct !== 'message.received') return direct
  if (message) {
    if (asRecord(message.extendedTextMessage)) return 'extended_text'
    if (asRecord(message.imageMessage)) return 'image'
    if (asRecord(message.videoMessage)) return 'video'
    if (asRecord(message.audioMessage)) return 'audio'
    if (asRecord(message.documentMessage)) return 'document'
  }
  return 'text'
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

  const senderIdRaw = firstString(
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

  if (!chatId || !senderIdRaw || !text) return null
  const senderId = normalizeSenderId(senderIdRaw)

  const occurredAt =
    firstString(
      extracted.payload.occurredAt,
      extracted.payload.timestamp,
      extracted.payload.ts,
      extracted.envelope.occurredAt,
      extracted.envelope.timestamp
    ) ?? new Date().toISOString()

  const mentionedJids = Array.from(
    new Set([
      ...readMentionedJids(extracted.payload),
      ...readMentionedJids(message),
      ...readMentionedJids(asRecord(message?.extendedTextMessage)),
      ...readMentionedJids(asRecord(message?.imageMessage)),
      ...readMentionedJids(asRecord(message?.videoMessage)),
      ...readMentionedJids(asRecord(message?.audioMessage)),
      ...readMentionedJids(asRecord(message?.documentMessage)),
    ])
  )

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
    senderPhone: extractStablePhone(extracted.payload.senderPhone, senderId),
    pushName: firstString(
      extracted.payload.pushName,
      extracted.payload.senderName,
      extracted.payload.notifyName,
      message?.pushName,
      extracted.envelope.pushName
    ),
    isGroup: chatId.endsWith('@g.us'),
    messageId,
    text,
    messageType: inferMessageType(extracted.payload, message),
    mentionedJids,
    occurredAt,
    raw,
  }
}

export function normalizeReactionEvent(raw: unknown): ReactionEvent | null {
  const extracted = extractPayloadEnvelope(raw)
  if (!extracted) return null

  const eventName = firstString(extracted.envelope.event, extracted.envelope.type, extracted.payload.event, extracted.payload.type)
  if (eventName !== 'message.reaction') return null

  const reactionPayload = asRecord(extracted.payload.data) ?? extracted.payload
  const chatId = firstString(reactionPayload.chatId, reactionPayload.remoteJid, reactionPayload.from)
  const messageId = firstString(reactionPayload.messageId, reactionPayload.id)
  const senderId = firstString(reactionPayload.senderId, reactionPayload.author, reactionPayload.participant, reactionPayload.from)

  if (!chatId || !messageId || !senderId) return null

  const emojiRaw = reactionPayload.reaction
  const emoji = typeof emojiRaw === 'string' ? emojiRaw : emojiRaw === null ? null : null
  const occurredAt =
    firstString(
      extracted.payload.timestamp,
      reactionPayload.timestamp,
      extracted.envelope.timestamp,
      extracted.payload.occurredAt,
      extracted.envelope.occurredAt
    ) ?? new Date().toISOString()

  return {
    provider: 'openwa',
    eventType: 'message.reaction',
    sessionId: firstString(extracted.envelope.sessionId, extracted.envelope.session_id, extracted.payload.sessionId, extracted.payload.session_id),
    chatId,
    messageId,
    senderId,
    senderPhone: extractStablePhone(reactionPayload.senderPhone, senderId),
    emoji,
    removed: emoji === null || emoji === '',
    occurredAt,
    raw,
  }
}

export function normalizePresenceUpdateEvent(raw: unknown): PresenceUpdateEvent | null {
  const extracted = extractPayloadEnvelope(raw)
  if (!extracted) return null

  const eventName = firstString(extracted.envelope.event, extracted.envelope.type, extracted.payload.event, extracted.payload.type)
  if (eventName !== 'presence.update') return null

  const presencePayload = asRecord(extracted.payload.data) ?? extracted.payload
  const chatId = firstString(presencePayload.chatId, presencePayload.remoteJid, presencePayload.id, presencePayload.from)
  if (!chatId) return null

  const updates: PresenceUpdateEvent['updates'] = []
  const directParticipantRaw = firstString(
    presencePayload.participantId,
    presencePayload.participant,
    presencePayload.senderId,
    presencePayload.id,
    extracted.payload.participantId,
    extracted.payload.participant
  )
  const directPresence = firstString(
    presencePayload.rawState,
    presencePayload.state,
    presencePayload.presence,
    presencePayload.lastKnownPresence,
    extracted.payload.rawState,
    extracted.payload.state
  )
  if (directParticipantRaw && directPresence) {
    const participantId = normalizeSenderId(directParticipantRaw)
    updates.push({
      participantId,
      participantPhone: extractStablePhone(presencePayload.phone, participantId),
      presence: directPresence,
    })
  }

  const presencesArray = Array.isArray(presencePayload.presences) ? presencePayload.presences : null
  if (presencesArray) {
    for (const item of presencesArray) {
      const record = asRecord(item)
      if (!record) continue
      const participantRaw = firstString(record.participant, record.senderId, record.id, record.from)
      const presence = firstString(record.presence, record.lastKnownPresence, record.status)
      if (!participantRaw || !presence) continue
      const participantId = normalizeSenderId(participantRaw)
      updates.push({
        participantId,
        participantPhone: extractStablePhone(record.phone, participantId),
        presence,
      })
    }
  } else {
    const presencesRecord = asRecord(presencePayload.presences)
    if (presencesRecord) {
      for (const [participantKey, value] of Object.entries(presencesRecord)) {
        const record = asRecord(value)
        const presence = firstString(record?.presence, record?.lastKnownPresence, record?.status)
        if (!presence) continue
        const participantId = normalizeSenderId(participantKey)
        updates.push({
          participantId,
          participantPhone: extractStablePhone(record?.phone, participantId),
          presence,
        })
      }
    }
  }

  const dedupedUpdates = Array.from(
    new Map(updates.map((item) => [`${item.participantId}|${item.presence}`, item])).values()
  )
  if (dedupedUpdates.length === 0) return null

  const occurredAt =
    firstString(
      presencePayload.occurredAt,
      presencePayload.timestamp,
      presencePayload.ts,
      extracted.envelope.occurredAt,
      extracted.envelope.timestamp
    ) ?? new Date().toISOString()

  return {
    provider: 'openwa',
    eventType: 'presence.update',
    sessionId: firstString(extracted.envelope.sessionId, extracted.envelope.session_id, extracted.payload.sessionId, extracted.payload.session_id),
    chatId,
    isGroup: chatId.endsWith('@g.us'),
    updates: dedupedUpdates,
    occurredAt,
    raw,
  }
}

export function normalizeOpenwaEvent(raw: unknown): NormalizedOpenwaEvent | null {
  return normalizeInboundMessageEvent(raw) ?? normalizeReactionEvent(raw) ?? normalizePresenceUpdateEvent(raw)
}
