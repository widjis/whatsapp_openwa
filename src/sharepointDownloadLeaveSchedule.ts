import axios from 'axios'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type TokenCache = {
  accessToken: string
  refreshToken?: string
  expiresAtMs: number
  scope: string
  tenantId: string
  clientId: string
}

type DeviceCodeResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval?: number
  message?: string
}

type TokenResponseOk = {
  token_type: 'Bearer' | string
  scope: string
  expires_in: number
  ext_expires_in?: number
  access_token: string
  refresh_token?: string
}

type TokenResponseErr = {
  error: string
  error_description?: string
  error_codes?: number[]
  timestamp?: string
  trace_id?: string
  correlation_id?: string
}

function normalizeScopeString(scope: string): string {
  const unique = Array.from(
    new Set(
      scope
        .split(/\s+/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  )
  unique.sort((a, b) => a.localeCompare(b))
  return unique.join(' ')
}

function ensureOfflineAccessScope(scope: string): string {
  const parts = scope
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  if (!parts.includes('offline_access')) parts.push('offline_access')
  return normalizeScopeString(parts.join(' '))
}

function hasAllScopes(args: { cachedScope: string; requiredScope: string }): boolean {
  const cached = new Set(
    args.cachedScope
      .split(/\s+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  )
  const required = args.requiredScope
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  if (required.length === 0) return false
  return required.every((value) => cached.has(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTokenOk(value: unknown): value is TokenResponseOk {
  if (!isRecord(value)) return false
  return typeof value.access_token === 'string' && typeof value.expires_in === 'number' && typeof value.scope === 'string'
}

function isTokenErr(value: unknown): value is TokenResponseErr {
  if (!isRecord(value)) return false
  return typeof value.error === 'string'
}

function getDataDir(): string {
  const raw = process.env.DATA_DIR
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const resolved = raw.trim()
    return path.isAbsolute(resolved) ? resolved : path.join(process.cwd(), resolved)
  }
  return path.join(process.cwd(), 'data')
}

function getGraphScopesEnv(): string {
  if (typeof process.env.MS_GRAPH_SCOPES === 'string' && process.env.MS_GRAPH_SCOPES.trim().length > 0) {
    return process.env.MS_GRAPH_SCOPES.trim()
  }
  if (typeof process.env.MS_SCOPES === 'string' && process.env.MS_SCOPES.trim().length > 0) {
    return process.env.MS_SCOPES.trim()
  }
  return 'Files.Read'
}

export function resolveDataDir(): string {
  return getDataDir()
}

export function resolveSharepointTokenCachePath(dataDir: string): string {
  const raw = process.env.SHAREPOINT_TOKEN_CACHE_PATH ?? process.env.MS_TOKEN_CACHE_PATH
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const resolved = raw.trim()
    return path.isAbsolute(resolved) ? resolved : path.join(dataDir, resolved)
  }
  return path.join(dataDir, 'sharepoint_token_cache.json')
}

function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function shareUrlToShareId(url: string): string {
  return `u!${toBase64Url(url)}`
}

async function readTokenCache(cachePath: string): Promise<TokenCache | null> {
  try {
    const raw = await fs.readFile(cachePath, 'utf8')
    const parsedUnknown: unknown = JSON.parse(raw)
    if (!isRecord(parsedUnknown)) return null

    const accessToken = parsedUnknown.accessToken
    const expiresAtMs = parsedUnknown.expiresAtMs
    const scope = parsedUnknown.scope
    const tenantId = parsedUnknown.tenantId
    const clientId = parsedUnknown.clientId
    if (
      typeof accessToken !== 'string' ||
      typeof expiresAtMs !== 'number' ||
      typeof scope !== 'string' ||
      typeof tenantId !== 'string' ||
      typeof clientId !== 'string'
    ) {
      return null
    }

    const refreshToken = typeof parsedUnknown.refreshToken === 'string' ? parsedUnknown.refreshToken : undefined
    return { accessToken, refreshToken, expiresAtMs, scope, tenantId, clientId }
  } catch {
    return null
  }
}

async function writeTokenCache(cachePath: string, value: TokenCache): Promise<void> {
  const dir = path.dirname(cachePath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(cachePath, JSON.stringify(value, null, 2), 'utf8')
}

async function requestDeviceCode(args: {
  tenantId: string
  clientId: string
  scope: string
}): Promise<DeviceCodeResponse> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(args.tenantId)}/oauth2/v2.0/devicecode`
  const form = new URLSearchParams({ client_id: args.clientId, scope: args.scope })
  const response = await axios.post(url, form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  const dataUnknown: unknown = response.data
  if (!isRecord(dataUnknown)) throw new Error('Unexpected device code response')

  const deviceCode = dataUnknown.device_code
  const userCode = dataUnknown.user_code
  const verificationUri = dataUnknown.verification_uri
  const expiresIn = dataUnknown.expires_in
  const interval = dataUnknown.interval
  const message = dataUnknown.message

  if (
    typeof deviceCode !== 'string' ||
    typeof userCode !== 'string' ||
    typeof verificationUri !== 'string' ||
    typeof expiresIn !== 'number'
  ) {
    throw new Error('Invalid device code response')
  }

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    expires_in: expiresIn,
    interval: typeof interval === 'number' ? interval : undefined,
    message: typeof message === 'string' ? message : undefined,
  }
}

async function pollTokenByDeviceCode(args: {
  tenantId: string
  clientId: string
  deviceCode: string
  intervalSeconds: number
  timeoutMs: number
}): Promise<TokenResponseOk> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(args.tenantId)}/oauth2/v2.0/token`
  const startedAt = Date.now()

  while (Date.now() - startedAt < args.timeoutMs) {
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: args.clientId,
      device_code: args.deviceCode,
    })

    try {
      const response = await axios.post(url, form, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      const dataUnknown: unknown = response.data
      if (isTokenOk(dataUnknown)) return dataUnknown
      throw new Error('Unexpected token response')
    } catch (error) {
      if (!axios.isAxiosError(error)) throw error
      const dataUnknown: unknown = error.response?.data
      if (isTokenErr(dataUnknown)) {
        if (dataUnknown.error === 'authorization_pending') {
          await new Promise((resolve) => setTimeout(resolve, args.intervalSeconds * 1000))
          continue
        }
        if (dataUnknown.error === 'slow_down') {
          await new Promise((resolve) => setTimeout(resolve, (args.intervalSeconds + 5) * 1000))
          continue
        }
        if (dataUnknown.error === 'authorization_declined' || dataUnknown.error === 'access_denied') {
          const desc = typeof dataUnknown.error_description === 'string' ? dataUnknown.error_description : ''
          throw new Error(
            [
              `${dataUnknown.error}${desc ? `: ${desc}` : ''}`,
              'If you see "Need admin approval", an Entra admin must approve the app.',
            ].join('\n')
          )
        }
        const desc = typeof dataUnknown.error_description === 'string' ? dataUnknown.error_description : ''
        throw new Error(`${dataUnknown.error}${desc ? `: ${desc}` : ''}`)
      }

      const status = error.response?.status
      throw new Error(`Token polling failed (status=${typeof status === 'number' ? status : 'unknown'})`)
    }
  }

  throw new Error('Device code timed out')
}

async function refreshAccessToken(args: {
  tenantId: string
  clientId: string
  refreshToken: string
  scope: string
}): Promise<TokenResponseOk> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(args.tenantId)}/oauth2/v2.0/token`
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: args.clientId,
    refresh_token: args.refreshToken,
    scope: args.scope,
  })
  const response = await axios.post(url, form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  const dataUnknown: unknown = response.data
  if (isTokenOk(dataUnknown)) return dataUnknown
  throw new Error('Unexpected refresh token response')
}

async function acquireGraphToken(args: {
  tenantId: string
  clientId: string
  scope: string
  cachePath: string
}): Promise<string> {
  const requestedScope = ensureOfflineAccessScope(args.scope)
  const cached = await readTokenCache(args.cachePath)
  const now = Date.now()
  let fallbackReason = 'cache_missing'

  if (
    cached &&
    cached.clientId === args.clientId &&
    cached.tenantId === args.tenantId &&
    hasAllScopes({ cachedScope: normalizeScopeString(cached.scope), requiredScope: requestedScope })
  ) {
    if (cached.expiresAtMs - now > 60_000) {
      console.log('SharePoint token cache hit: using unexpired access token')
      return cached.accessToken
    }

    fallbackReason = 'access_token_expired'
    if (cached.refreshToken) {
      try {
        const refreshed = await refreshAccessToken({
          tenantId: args.tenantId,
          clientId: args.clientId,
          refreshToken: cached.refreshToken,
          scope: requestedScope,
        })
        const expiresAtMs = now + refreshed.expires_in * 1000
        const next: TokenCache = {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token ?? cached.refreshToken,
          expiresAtMs,
          scope: normalizeScopeString(refreshed.scope),
          tenantId: args.tenantId,
          clientId: args.clientId,
        }
        await writeTokenCache(args.cachePath, next)
        console.log('SharePoint token cache refresh success: using refresh token')
        return next.accessToken
      } catch {
        fallbackReason = 'refresh_token_failed'
      }
    } else {
      fallbackReason = 'refresh_token_missing'
    }
  } else if (cached) {
    const sameClient = cached.clientId === args.clientId
    const sameTenant = cached.tenantId === args.tenantId
    const sameScope = hasAllScopes({ cachedScope: normalizeScopeString(cached.scope), requiredScope: requestedScope })
    fallbackReason = `cache_mismatch(client=${sameClient},tenant=${sameTenant},scope=${sameScope})`
  }

  console.log(`SharePoint device login required: ${fallbackReason}`)
  const device = await requestDeviceCode({
    tenantId: args.tenantId,
    clientId: args.clientId,
    scope: requestedScope,
  })
  if (device.message) console.log(device.message)
  else console.log(`Go to ${device.verification_uri} and enter code ${device.user_code}`)

  const token = await pollTokenByDeviceCode({
    tenantId: args.tenantId,
    clientId: args.clientId,
    deviceCode: device.device_code,
    intervalSeconds: Math.max(1, device.interval ?? 5),
    timeoutMs: Math.max(60_000, device.expires_in * 1000),
  })

  const expiresAtMs = Date.now() + token.expires_in * 1000
  const next: TokenCache = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAtMs,
    scope: normalizeScopeString(token.scope),
    tenantId: args.tenantId,
    clientId: args.clientId,
  }
  await writeTokenCache(args.cachePath, next)
  return next.accessToken
}

async function downloadDriveItemFromShareUrl(args: {
  shareUrl: string
  token: string
}): Promise<{ buf: Buffer; name?: string; webUrl?: string }> {
  const shareId = shareUrlToShareId(args.shareUrl)
  const itemUrl = `https://graph.microsoft.com/v1.0/shares/${encodeURIComponent(shareId)}/driveItem?$select=name,webUrl`
  const itemResponse = await axios.get(itemUrl, {
    headers: { Authorization: `Bearer ${args.token}` },
  })
  const itemUnknown: unknown = itemResponse.data
  const name = isRecord(itemUnknown) && typeof itemUnknown.name === 'string' ? itemUnknown.name : undefined
  const webUrl = isRecord(itemUnknown) && typeof itemUnknown.webUrl === 'string' ? itemUnknown.webUrl : undefined

  const contentUrl = `https://graph.microsoft.com/v1.0/shares/${encodeURIComponent(shareId)}/driveItem/content`
  const contentResponse = await axios.get<ArrayBuffer>(contentUrl, {
    headers: { Authorization: `Bearer ${args.token}` },
    responseType: 'arraybuffer',
    maxRedirects: 5,
  })

  return { buf: Buffer.from(contentResponse.data), name, webUrl }
}

export type SharepointDownloadResult = {
  buf: Buffer
  name: string | null
  webUrl: string | null
}

export async function downloadSharepointFile(args: {
  shareUrl: string
  tenantId: string
  clientId: string
  scope: string
  tokenCachePath: string
}): Promise<SharepointDownloadResult> {
  const token = await acquireGraphToken({
    tenantId: args.tenantId,
    clientId: args.clientId,
    scope: args.scope,
    cachePath: args.tokenCachePath,
  })
  const { buf, name, webUrl } = await downloadDriveItemFromShareUrl({
    shareUrl: args.shareUrl.trim(),
    token,
  })
  return {
    buf,
    name: typeof name === 'string' ? name : null,
    webUrl: typeof webUrl === 'string' ? webUrl : null,
  }
}

function looksLikeXlsx(buf: Buffer): boolean {
  if (buf.length < 4) return false
  return buf[0] === 0x50 && buf[1] === 0x4b
}

export async function writeFileAtomic(args: { targetPath: string; content: Buffer }): Promise<void> {
  const dir = path.dirname(args.targetPath)
  await fs.mkdir(dir, { recursive: true })
  const tempPath = `${args.targetPath}.tmp`
  await fs.writeFile(tempPath, args.content)
  await fs.rename(tempPath, args.targetPath)
}

export async function downloadSharepointFileToPath(args: {
  shareUrl: string
  tenantId: string
  clientId: string
  scope: string
  tokenCachePath: string
  targetPath: string
}): Promise<{ targetPath: string; webUrl: string | null; sourceName: string | null; bytes: number }> {
  const result = await downloadSharepointFile({
    shareUrl: args.shareUrl,
    tenantId: args.tenantId,
    clientId: args.clientId,
    scope: args.scope,
    tokenCachePath: args.tokenCachePath,
  })

  if (!looksLikeXlsx(result.buf)) throw new Error('Downloaded file does not look like an XLSX')

  await writeFileAtomic({ targetPath: args.targetPath, content: result.buf })

  return {
    targetPath: args.targetPath,
    webUrl: result.webUrl,
    sourceName: result.name,
    bytes: result.buf.length,
  }
}

async function main(): Promise<void> {
  const shareUrl = process.argv[2]
  if (typeof shareUrl !== 'string' || shareUrl.trim().length === 0) {
    throw new Error('Usage: tsx src/sharepointDownloadLeaveSchedule.ts "<share_url>"')
  }

  const tenantId = process.env.MS_TENANT_ID?.trim()
  const clientId = process.env.MS_CLIENT_ID?.trim()
  if (!tenantId || !clientId) {
    throw new Error('Missing MS_TENANT_ID or MS_CLIENT_ID')
  }

  const scope =
    getGraphScopesEnv()

  const dataDir = getDataDir()
  const tokenCachePath = resolveSharepointTokenCachePath(dataDir)
  const outPath = path.join(dataDir, 'leave_schedule.xlsx')

  await fs.mkdir(path.dirname(tokenCachePath), { recursive: true })
  const result = await downloadSharepointFileToPath({
    shareUrl: shareUrl.trim(),
    tenantId,
    clientId,
    scope,
    tokenCachePath,
    targetPath: outPath,
  })

  console.log('DOWNLOAD_OK')
  console.log(`Path: ${result.targetPath}`)
  if (result.webUrl) console.log(`WebUrl: ${result.webUrl}`)
}

const isDirectRun = (() => {
  try {
    const entry = typeof process.argv[1] === 'string' ? process.argv[1] : ''
    if (!entry) return false
    return path.resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (isDirectRun) {
  await main()
}
