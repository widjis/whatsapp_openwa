import { Redis as IORedis } from 'ioredis'

export type TicketState = {
  technician?: string
  ticketStatus?: string
  priority?: string
  lastActionAtIso?: string
  lastAssignedGroupName?: string | null
  lastAssignedIctTechnician?: string | null
  lastNotifiedHash?: string | null
  lastReminderAtIso?: string | null
  lastReminderHash?: string | null
  srfSentAttachmentUrls?: string[]
}

const inMemoryTicketState = new Map<string, TicketState>()
const redisConnectPromises = new WeakMap<IORedis, Promise<void>>()

let redisClient: IORedis | null | undefined

function formatErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getRedisClient(): IORedis | null {
  if (redisClient !== undefined) return redisClient

  const host = process.env.REDIS_HOST?.trim()
  const portRaw = process.env.REDIS_PORT?.trim()
  if (!host || !portRaw) {
    redisClient = null
    return null
  }

  const port = Number(portRaw)
  if (!Number.isFinite(port)) {
    redisClient = null
    return null
  }

  const client = new IORedis({ host, port, lazyConnect: true, maxRetriesPerRequest: 1 })
  client.on('error', (error: Error) => {
    console.error('Redis error:', error)
  })

  redisClient = client
  return client
}

async function ensureRedisConnected(redis: IORedis): Promise<void> {
  if (redis.status === 'ready') return

  const existing = redisConnectPromises.get(redis)
  if (existing) {
    await existing
    return
  }

  const connectPromise = (async () => {
    try {
      await redis.connect()
    } catch (error) {
      const message = formatErrorDetail(error).toLowerCase()
      if (!message.includes('already connecting/connected')) throw error
    } finally {
      redisConnectPromises.delete(redis)
    }
  })()

  redisConnectPromises.set(redis, connectPromise)
  await connectPromise
}

function buildTicketStateKey(ticketId: string): string {
  return `ticket:${ticketId}`
}

function safeParseTicketState(raw: string | null): TicketState | null {
  if (!raw) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    return {
      technician: typeof record.technician === 'string' ? record.technician : undefined,
      ticketStatus: typeof record.ticketStatus === 'string' ? record.ticketStatus : undefined,
      priority: typeof record.priority === 'string' ? record.priority : undefined,
      lastActionAtIso: typeof record.lastActionAtIso === 'string' ? record.lastActionAtIso : undefined,
      lastAssignedGroupName:
        typeof record.lastAssignedGroupName === 'string'
          ? record.lastAssignedGroupName
          : record.lastAssignedGroupName === null
            ? null
            : undefined,
      lastAssignedIctTechnician:
        typeof record.lastAssignedIctTechnician === 'string'
          ? record.lastAssignedIctTechnician
          : record.lastAssignedIctTechnician === null
            ? null
            : undefined,
      lastNotifiedHash:
        typeof record.lastNotifiedHash === 'string'
          ? record.lastNotifiedHash
          : record.lastNotifiedHash === null
            ? null
            : undefined,
      lastReminderAtIso:
        typeof record.lastReminderAtIso === 'string'
          ? record.lastReminderAtIso
          : record.lastReminderAtIso === null
            ? null
            : undefined,
      lastReminderHash:
        typeof record.lastReminderHash === 'string'
          ? record.lastReminderHash
          : record.lastReminderHash === null
            ? null
            : undefined,
      srfSentAttachmentUrls: Array.isArray(record.srfSentAttachmentUrls)
        ? (record.srfSentAttachmentUrls.filter((item) => typeof item === 'string') as string[])
        : undefined,
    }
  } catch {
    return null
  }
}

export async function loadPreviousTicketState(ticketId: string): Promise<TicketState | null> {
  const memory = inMemoryTicketState.get(ticketId)
  const redis = getRedisClient()
  if (!redis) return memory ?? null

  try {
    await ensureRedisConnected(redis)
    const raw = await redis.get(buildTicketStateKey(ticketId))
    const parsed = safeParseTicketState(raw)
    return parsed ?? memory ?? null
  } catch (error) {
    const host = process.env.REDIS_HOST ?? 'unknown'
    const port = process.env.REDIS_PORT ?? 'unknown'
    console.error(`Failed to load ticket state from Redis (${host}:${port}): ${formatErrorDetail(error)}`)
    return memory ?? null
  }
}

export async function saveTicketState(ticketId: string, state: TicketState): Promise<void> {
  inMemoryTicketState.set(ticketId, state)

  const redis = getRedisClient()
  if (!redis) return

  try {
    await ensureRedisConnected(redis)
    await redis.set(buildTicketStateKey(ticketId), JSON.stringify(state))
  } catch (error) {
    const host = process.env.REDIS_HOST ?? 'unknown'
    const port = process.env.REDIS_PORT ?? 'unknown'
    console.error(`Failed to save ticket state to Redis (${host}:${port}): ${formatErrorDetail(error)}`)
  }
}
