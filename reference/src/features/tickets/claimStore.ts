import { Redis as IORedis } from 'ioredis';

export type TicketClaimRecord = {
  ticketId: string;
  remoteJid: string;
  messageId: string;
  createdAtIso: string;
  claimed: boolean;
  previousStatus?: string | null;
  previousIctTechnician?: string | null;
  previousTechnicianName?: string | null;
  previousGroupName?: string | null;
  claimedAtIso?: string;
  claimedByPhone?: string;
  claimedByName?: string;
};

type ClaimResult =
  | { ok: true; record: TicketClaimRecord; wasClaimed: false }
  | { ok: true; record: TicketClaimRecord; wasClaimed: true }
  | { ok: false; reason: 'not_found' | 'invalid_record' | 'storage_error'; detail?: string };

type UnclaimResult =
  | { ok: true; record: TicketClaimRecord; wasUnclaimed: true }
  | { ok: true; record: TicketClaimRecord; wasUnclaimed: false }
  | {
      ok: false;
      reason: 'not_found' | 'invalid_record' | 'storage_error' | 'not_claimed' | 'not_claimer';
      detail?: string;
    };

const inMemoryRecords = new Map<string, TicketClaimRecord>();
const inMemoryLocks = new Map<string, string>();
const redisConnectPromises = new WeakMap<IORedis, Promise<void>>();

let redisClient: IORedis | null | undefined;

function getRedisClient(): IORedis | null {
  if (redisClient !== undefined) return redisClient;
  const host = process.env.REDIS_HOST;
  const portRaw = process.env.REDIS_PORT;
  if (!host || !portRaw) {
    redisClient = null;
    return null;
  }

  const port = Number(portRaw);
  if (!Number.isFinite(port)) {
    redisClient = null;
    return null;
  }

  const client = new IORedis({ host, port, lazyConnect: true, maxRetriesPerRequest: 1 });
  client.on('error', (err: Error) => {
    console.error('Redis error:', err);
  });
  redisClient = client;
  return client;
}

function formatErrorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function ensureRedisConnected(redis: IORedis): Promise<void> {
  if (redis.status === 'ready') return;

  const existing = redisConnectPromises.get(redis);
  if (existing) {
    await existing;
    return;
  }

  const connectPromise = (async () => {
    try {
      await redis.connect();
    } catch (error) {
      const message = formatErrorDetail(error);
      if (message.toLowerCase().includes('already connecting/connected')) return;
      throw error;
    } finally {
      redisConnectPromises.delete(redis);
    }
  })();

  redisConnectPromises.set(redis, connectPromise);
  await connectPromise;
}

function recordKey(remoteJid: string, messageId: string): string {
  return `ticket_claim:${remoteJid}:${messageId}`;
}

function lockKey(remoteJid: string, messageId: string): string {
  return `ticket_claim_lock:${remoteJid}:${messageId}`;
}

function parseRecord(raw: string | null): TicketClaimRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const r = parsed as Record<string, unknown>;
    const ticketId = typeof r.ticketId === 'string' ? r.ticketId : '';
    const remoteJid = typeof r.remoteJid === 'string' ? r.remoteJid : '';
    const messageId = typeof r.messageId === 'string' ? r.messageId : '';
    const createdAtIso = typeof r.createdAtIso === 'string' ? r.createdAtIso : '';
    const claimed = typeof r.claimed === 'boolean' ? r.claimed : false;
    const previousStatus = typeof r.previousStatus === 'string' ? r.previousStatus : r.previousStatus === null ? null : undefined;
    const previousIctTechnician =
      typeof r.previousIctTechnician === 'string' ? r.previousIctTechnician : r.previousIctTechnician === null ? null : undefined;
    const previousTechnicianName =
      typeof r.previousTechnicianName === 'string'
        ? r.previousTechnicianName
        : r.previousTechnicianName === null
          ? null
          : undefined;
    const previousGroupName =
      typeof r.previousGroupName === 'string' ? r.previousGroupName : r.previousGroupName === null ? null : undefined;
    const claimedAtIso = typeof r.claimedAtIso === 'string' ? r.claimedAtIso : undefined;
    const claimedByPhone = typeof r.claimedByPhone === 'string' ? r.claimedByPhone : undefined;
    const claimedByName = typeof r.claimedByName === 'string' ? r.claimedByName : undefined;

    if (!ticketId || !remoteJid || !messageId || !createdAtIso) return null;
    return {
      ticketId,
      remoteJid,
      messageId,
      createdAtIso,
      claimed,
      previousStatus,
      previousIctTechnician,
      previousTechnicianName,
      previousGroupName,
      claimedAtIso,
      claimedByPhone,
      claimedByName,
    };
  } catch {
    return null;
  }
}

export async function storeTicketNotification(args: {
  ticketId: string;
  remoteJid: string;
  messageId: string;
}): Promise<void> {
  const record: TicketClaimRecord = {
    ticketId: args.ticketId,
    remoteJid: args.remoteJid,
    messageId: args.messageId,
    createdAtIso: new Date().toISOString(),
    claimed: false,
  };

  const key = recordKey(args.remoteJid, args.messageId);
  inMemoryRecords.set(key, record);
  inMemoryLocks.delete(lockKey(args.remoteJid, args.messageId));

  const redis = getRedisClient();
  if (!redis) return;

  try {
    await ensureRedisConnected(redis);
    await redis.set(key, JSON.stringify(record));
    await redis.del(lockKey(args.remoteJid, args.messageId));
  } catch (error) {
    const host = process.env.REDIS_HOST ?? 'unknown';
    const port = process.env.REDIS_PORT ?? 'unknown';
    console.error(`Failed to persist ticket claim record to Redis (${host}:${port}): ${formatErrorDetail(error)}`);
    return;
  }
}

export async function loadTicketNotification(args: {
  remoteJid: string;
  messageId: string;
}): Promise<TicketClaimRecord | null> {
  const key = recordKey(args.remoteJid, args.messageId);
  const redis = getRedisClient();
  if (!redis) return inMemoryRecords.get(key) ?? null;

  try {
    await ensureRedisConnected(redis);
    const raw = await redis.get(key);
    const parsed = parseRecord(raw);
    if (parsed) return parsed;
    return inMemoryRecords.get(key) ?? null;
  } catch (error) {
    const host = process.env.REDIS_HOST ?? 'unknown';
    const port = process.env.REDIS_PORT ?? 'unknown';
    console.error(`Failed to load ticket claim record from Redis (${host}:${port}): ${formatErrorDetail(error)}`);
    return inMemoryRecords.get(key) ?? null;
  }
}

export async function claimTicketNotification(args: {
  remoteJid: string;
  messageId: string;
  claimantPhone: string;
  claimantName: string;
  previous?: {
    status?: string | null;
    ictTechnician?: string | null;
    technicianName?: string | null;
    groupName?: string | null;
  };
}): Promise<ClaimResult> {
  const key = recordKey(args.remoteJid, args.messageId);
  const lock = lockKey(args.remoteJid, args.messageId);

  const existing = inMemoryRecords.get(key);
  if (!existing) {
    const redis = getRedisClient();
    if (!redis) return { ok: false, reason: 'not_found' };
    try {
      await ensureRedisConnected(redis);
      const raw = await redis.get(key);
      const parsed = parseRecord(raw);
      if (!parsed) return { ok: false, reason: raw ? 'invalid_record' : 'not_found' };
      inMemoryRecords.set(key, parsed);
    } catch (error) {
      const host = process.env.REDIS_HOST ?? 'unknown';
      const port = process.env.REDIS_PORT ?? 'unknown';
      const detail = `Redis read failed (${host}:${port}): ${formatErrorDetail(error)}`;
      console.error(detail);
      return { ok: false, reason: 'storage_error', detail };
    }
  }

  const fromMem = inMemoryRecords.get(key);
  if (!fromMem) return { ok: false, reason: 'not_found' };
  if (fromMem.claimed) return { ok: true, record: fromMem, wasClaimed: true };

  const redis = getRedisClient();
  if (!redis) {
    if (inMemoryLocks.has(lock)) {
      const current = inMemoryRecords.get(key);
      return current ? { ok: true, record: current, wasClaimed: true } : { ok: false, reason: 'not_found' };
    }

    inMemoryLocks.set(lock, args.claimantPhone);
    const updated: TicketClaimRecord = {
      ...fromMem,
      claimed: true,
      previousStatus: args.previous?.status ?? fromMem.previousStatus,
      previousIctTechnician: args.previous?.ictTechnician ?? fromMem.previousIctTechnician,
      previousTechnicianName: args.previous?.technicianName ?? fromMem.previousTechnicianName,
      previousGroupName: args.previous?.groupName ?? fromMem.previousGroupName,
      claimedAtIso: new Date().toISOString(),
      claimedByPhone: args.claimantPhone,
      claimedByName: args.claimantName,
    };
    inMemoryRecords.set(key, updated);
    return { ok: true, record: updated, wasClaimed: false };
  }

  try {
    await ensureRedisConnected(redis);
    const lockSet = await redis.set(lock, args.claimantPhone, 'EX', 60 * 60 * 24, 'NX');
    if (lockSet !== 'OK') {
      const current = await loadTicketNotification({ remoteJid: args.remoteJid, messageId: args.messageId });
      if (!current) return { ok: false, reason: 'not_found' };
      return { ok: true, record: current, wasClaimed: true };
    }

    const current = await loadTicketNotification({ remoteJid: args.remoteJid, messageId: args.messageId });
    if (!current) return { ok: false, reason: 'not_found' };

    const updated: TicketClaimRecord = {
      ...current,
      claimed: true,
      previousStatus: args.previous?.status ?? current.previousStatus,
      previousIctTechnician: args.previous?.ictTechnician ?? current.previousIctTechnician,
      previousTechnicianName: args.previous?.technicianName ?? current.previousTechnicianName,
      previousGroupName: args.previous?.groupName ?? current.previousGroupName,
      claimedAtIso: new Date().toISOString(),
      claimedByPhone: args.claimantPhone,
      claimedByName: args.claimantName,
    };

    await redis.set(key, JSON.stringify(updated));
    inMemoryRecords.set(key, updated);
    return { ok: true, record: updated, wasClaimed: false };
  } catch (error) {
    const host = process.env.REDIS_HOST ?? 'unknown';
    const port = process.env.REDIS_PORT ?? 'unknown';
    const detail = `Redis write failed (${host}:${port}): ${formatErrorDetail(error)}`;
    console.error(detail);
    return { ok: false, reason: 'storage_error', detail };
  }
}

export async function unclaimTicketNotification(args: {
  remoteJid: string;
  messageId: string;
  claimantPhone: string;
}): Promise<UnclaimResult> {
  const key = recordKey(args.remoteJid, args.messageId);
  const lock = lockKey(args.remoteJid, args.messageId);

  const existing = inMemoryRecords.get(key);
  if (!existing) {
    const redis = getRedisClient();
    if (!redis) return { ok: false, reason: 'not_found' };
    try {
      await ensureRedisConnected(redis);
      const raw = await redis.get(key);
      const parsed = parseRecord(raw);
      if (!parsed) return { ok: false, reason: raw ? 'invalid_record' : 'not_found' };
      inMemoryRecords.set(key, parsed);
    } catch (error) {
      const host = process.env.REDIS_HOST ?? 'unknown';
      const port = process.env.REDIS_PORT ?? 'unknown';
      const detail = `Redis read failed (${host}:${port}): ${formatErrorDetail(error)}`;
      console.error(detail);
      return { ok: false, reason: 'storage_error', detail };
    }
  }

  const fromMem = inMemoryRecords.get(key);
  if (!fromMem) return { ok: false, reason: 'not_found' };
  if (!fromMem.claimed) return { ok: false, reason: 'not_claimed' };
  if (fromMem.claimedByPhone && fromMem.claimedByPhone !== args.claimantPhone) {
    return { ok: false, reason: 'not_claimer' };
  }

  const updated: TicketClaimRecord = {
    ...fromMem,
    claimed: false,
    claimedAtIso: undefined,
    claimedByPhone: undefined,
    claimedByName: undefined,
  };

  const redis = getRedisClient();
  if (!redis) {
    inMemoryLocks.delete(lock);
    inMemoryRecords.set(key, updated);
    return { ok: true, record: updated, wasUnclaimed: true };
  }

  try {
    await ensureRedisConnected(redis);

    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      await redis.watch(key);

      const raw = await redis.get(key);
      const current = parseRecord(raw);
      if (!current) {
        await redis.unwatch();
        return { ok: false, reason: raw ? 'invalid_record' : 'not_found' };
      }

      if (!current.claimed) {
        await redis.unwatch();
        return { ok: false, reason: 'not_claimed' };
      }

      if (current.claimedByPhone && current.claimedByPhone !== args.claimantPhone) {
        await redis.unwatch();
        return { ok: false, reason: 'not_claimer' };
      }

      const next: TicketClaimRecord = {
        ...current,
        claimed: false,
        claimedAtIso: undefined,
        claimedByPhone: undefined,
        claimedByName: undefined,
      };

      const execRes = await redis.multi().set(key, JSON.stringify(next)).del(lock).exec();
      if (execRes) {
        inMemoryLocks.delete(lock);
        inMemoryRecords.set(key, next);
        return { ok: true, record: next, wasUnclaimed: true };
      }
    }

    const currentAfter = await loadTicketNotification({ remoteJid: args.remoteJid, messageId: args.messageId });
    if (!currentAfter) return { ok: false, reason: 'not_found' };
    return { ok: true, record: currentAfter, wasUnclaimed: false };
  } catch (error) {
    const host = process.env.REDIS_HOST ?? 'unknown';
    const port = process.env.REDIS_PORT ?? 'unknown';
    const detail = `Redis write failed (${host}:${port}): ${formatErrorDetail(error)}`;
    console.error(detail);
    return { ok: false, reason: 'storage_error', detail };
  }
}
