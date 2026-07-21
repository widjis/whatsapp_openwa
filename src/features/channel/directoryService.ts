import type { GroupMetadata, GroupSummary, SessionSummary } from './types.js';
import { OpenwaClient } from './openwaClient.js';

function readBooleanLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return null;
}

function parseCheckRegistered(payload: unknown): boolean {
  if (typeof payload === 'boolean') return payload;
  if (!payload || typeof payload !== 'object') return false;

  const record = payload as Record<string, unknown>;
  for (const candidate of [record.exists, record.registered, record.onWhatsApp, record.valid]) {
    const parsed = readBooleanLike(candidate);
    if (parsed !== null) return parsed;
  }

  const data = record.data;
  return data && typeof data === 'object' ? parseCheckRegistered(data) : false;
}

function parseGroups(payload: unknown): GroupSummary[] {
  const root =
    Array.isArray(payload) ? payload : payload && typeof payload === 'object' ? ((payload as Record<string, unknown>).data as unknown) : null;

  if (!Array.isArray(root)) return [];

  return root.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : typeof record.groupId === 'string' ? record.groupId : null;
    const subject =
      typeof record.subject === 'string'
        ? record.subject
        : typeof record.name === 'string'
          ? record.name
          : typeof record.title === 'string'
            ? record.title
            : null;

    return id && subject ? [{ id, subject }] : [];
  });
}

function parseGroupMetadata(payload: unknown): GroupMetadata | null {
  if (!payload || typeof payload !== 'object') return null;

  const root = payload as Record<string, unknown>;
  const source = root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : root;
  const announce =
    readBooleanLike(source.announce) ??
    readBooleanLike(source.isAnnounce) ??
    readBooleanLike(source.onlyAdminsCanSend) ??
    null;

  const participantsRaw = Array.isArray(source.participants) ? source.participants : null;
  const participants = participantsRaw
    ? participantsRaw.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        const id =
          typeof record.id === 'string'
            ? record.id
            : typeof record.contactId === 'string'
              ? record.contactId
              : typeof record.phone === 'string'
                ? `${record.phone}@c.us`
                : null;
        if (!id) return [];

        const isAdmin =
          readBooleanLike(record.isAdmin) ??
          readBooleanLike(record.admin) ??
          (typeof record.role === 'string' ? record.role.toLowerCase().includes('admin') : false);

        return [{ id, isAdmin: Boolean(isAdmin) }];
      })
    : null;

  return { announce, participants };
}

type GroupCacheSnapshot = {
  fetchedAtMs: number;
  entries: GroupSummary[];
};

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export class DirectoryService {
  private groupCache: GroupCacheSnapshot | null = null;
  private selfJid: string | null = null;

  constructor(private readonly client: OpenwaClient) {}

  async checkRegisteredNumber(value: string): Promise<boolean> {
    const sessionId = await this.client.resolveSessionId();
    const digits = value.replace(/[^\d]/g, '');
    const payload = await this.client.get<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/contacts/check/${encodeURIComponent(digits)}`
    );
    return parseCheckRegistered(payload);
  }

  async listGroups(options?: { forceRefresh?: boolean }): Promise<GroupSummary[]> {
    const ttlMs = readPositiveIntEnv('OPENWA_GROUP_CACHE_TTL_MS', 5 * 60 * 1000);
    const forceRefresh = options?.forceRefresh === true;
    const cacheStillValid = this.groupCache && Date.now() - this.groupCache.fetchedAtMs <= ttlMs;
    if (!forceRefresh && cacheStillValid) {
      return this.groupCache!.entries;
    }

    const sessionId = await this.client.resolveSessionId();
    const payload = await this.client.get<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/groups`);
    const entries = parseGroups(payload);
    this.groupCache = {
      fetchedAtMs: Date.now(),
      entries,
    };
    return entries;
  }

  async getGroupMetadata(groupId: string): Promise<GroupMetadata | null> {
    const sessionId = await this.client.resolveSessionId();
    const payload = await this.client.get<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/groups/${encodeURIComponent(groupId)}`
    );
    return parseGroupMetadata(payload);
  }

  async getSelfJid(): Promise<string | null> {
    if (this.selfJid) return this.selfJid;
    const sessionId = await this.client.resolveSessionId();
    const payload = await this.client.get<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const phoneRaw = typeof payload.phone === 'string' ? payload.phone : '';
    const digits = phoneRaw.replace(/[^\d]/g, '');
    if (!digits) return null;
    this.selfJid = `${digits}@c.us`;
    return this.selfJid;
  }

  invalidateGroupsCache(): void {
    this.groupCache = null;
  }

  async resolveGroupIdByName(name: string): Promise<string | null> {
    const query = name.trim().toLowerCase();
    if (!query) return null;

    const findMatch = (groups: GroupSummary[]): GroupSummary | undefined =>
      groups.find((group) => group.subject.toLowerCase().includes(query));

    const cached = await this.listGroups();
    const cachedMatch = findMatch(cached);
    if (cachedMatch) return cachedMatch.id;

    const refreshed = await this.listGroups({ forceRefresh: true });
    const refreshedMatch = findMatch(refreshed);
    return refreshedMatch?.id ?? null;
  }

  async resolvePhone(contactId: string): Promise<string | null> {
    const sessionId = await this.client.resolveSessionId();
    const payload = await this.client.get<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/contacts/${encodeURIComponent(contactId)}/phone`
    );

    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      if (typeof record.phone === 'string') return record.phone;
      if (typeof record.data === 'string') return record.data;
      if (record.data && typeof record.data === 'object' && typeof (record.data as Record<string, unknown>).phone === 'string') {
        return (record.data as Record<string, unknown>).phone as string;
      }
    }

    return null;
  }
}
