import ldap from 'ldapjs'
import sql from 'mssql'

export type FindUserRecord = {
  displayName: string
  userPrincipalName?: string
  mail?: string
  title?: string
  department?: string
  mobile?: string
  telephoneNumber?: string
  employeeID?: string
  pwdLastSet?: string
  passwordExpiryTimeComputed?: string
  photoBuffer?: Buffer
  photoContentType?: string
}

export type FindUsersResult =
  | {
      success: true
      users: FindUserRecord[]
    }
  | {
      success: false
      error: string
    }

export type BitLockerRecoveryKey = {
  partitionId: string
  password: string
}

export type GetBitLockerInfoResult =
  | {
      success: true
      data: {
        hostname: string
        keys: BitLockerRecoveryKey[]
      }
    }
  | {
      success: false
      error: string
    }

export type LapsInfo = {
  hostname: string
  account: string | null
  password: string
  source: 'msLAPS-Password' | 'ms-Mcs-AdmPwd' | 'powershell-bridge'
  expiration: string | null
}

export type GetLapsInfoResult =
  | {
      success: true
      data: LapsInfo
    }
  | {
      success: false
      error: string
    }

export type LapsDiagnostics = {
  hostname: string
  distinguishedName: string
  visibleAttributes: {
    msLapsPassword: boolean
    msLapsEncryptedPassword: boolean
    msLapsPasswordExpirationTime: boolean
    msMcsAdmPwd: boolean
    msMcsAdmPwdExpirationTime: boolean
  }
}

export type GetLapsDiagnosticsResult =
  | {
      success: true
      data: LapsDiagnostics
    }
  | {
      success: false
      error: string
    }

export type ResetPasswordResult =
  | { success: true }
  | {
      success: false
      error: string
    }

export type UnlockAccountResult =
  | { success: true }
  | {
      success: false
      error: string
    }

type ResolveUserDnResult =
  | { ok: true; dn: string }
  | {
      ok: false
      error: string
    }

type LdapErrorLike = Error & {
  code?: number | string
  errno?: number | string
  lde_message?: string
  lde_dn?: string
}

type DbPhotoRow = {
  PHOTO: Buffer | null
}

let dbPool: sql.ConnectionPool | undefined
let dbPoolConnectPromise: Promise<sql.ConnectionPool> | undefined

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} must be set in environment`)
  }
  return value
}

function readBaseDn(): string {
  return process.env.BASE_DN ?? process.env.LDAP_BASE_DN ?? process.env.BASE_OU ?? ''
}

function getDbConfig(): sql.config {
  return {
    user: readRequiredEnv('DB_USER'),
    password: readRequiredEnv('DB_PASSWORD'),
    server: readRequiredEnv('DB_SERVER'),
    database: readRequiredEnv('DB_DATABASE'),
    options: {
      trustServerCertificate: true,
      encrypt: false,
    },
  }
}

function escapeLdapFilterValue(value: string): string {
  return value.replace(/[\\*()\\\0]/g, (char) => {
    switch (char) {
      case '\\':
        return '\\5c'
      case '*':
        return '\\2a'
      case '(':
        return '\\28'
      case ')':
        return '\\29'
      case '\0':
        return '\\00'
      default:
        return char
    }
  })
}

function formatLdapError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }

  const ldapError = error as LdapErrorLike
  const parts = [error.message]

  if (ldapError.code !== undefined) {
    parts.push(`code=${String(ldapError.code)}`)
  }
  if (ldapError.errno !== undefined && ldapError.errno !== ldapError.code) {
    parts.push(`errno=${String(ldapError.errno)}`)
  }
  if (ldapError.lde_message) {
    parts.push(`ldap=${ldapError.lde_message}`)
  }
  if (ldapError.lde_dn) {
    parts.push(`dn=${ldapError.lde_dn}`)
  }

  return parts.join(' | ')
}

function formatWindowsFileTime(value?: string): string | undefined {
  if (!value) return undefined

  try {
    const raw = BigInt(value)
    if (raw <= 0n) return undefined

    const unixEpochOffset = 116444736000000000n
    if (raw <= unixEpochOffset) return undefined

    const msBig = (raw - unixEpochOffset) / 10000n
    const ms = Number(msBig)
    if (!Number.isFinite(ms)) return undefined

    const date = new Date(ms)
    if (Number.isNaN(date.getTime())) return undefined
    return date.toLocaleString()
  } catch {
    return undefined
  }
}

function isExceptionallyLongDateString(dateString: string): boolean {
  const parsed = new Date(dateString)
  if (Number.isNaN(parsed.getTime())) return false
  return parsed.getFullYear() > 2100
}

function looksLikeImage(buffer: Buffer): boolean {
  if (buffer.length < 8) return false

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (isJpeg) return true

  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  if (isPng) return true

  return buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46
}

function normalizeAttributeType(type: string): string {
  return type.toLowerCase().split(';')[0] ?? type.toLowerCase()
}

function decodeMaybeBase64Image(value: string): Buffer | undefined {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length < 32) return undefined
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return undefined

  try {
    const decoded = Buffer.from(trimmed, 'base64')
    if (!looksLikeImage(decoded)) return undefined
    return decoded
  } catch {
    return undefined
  }
}

function extractPhotoFromEntry(entry: ldap.SearchEntry): { buffer: Buffer; contentType?: string } | undefined {
  for (const candidate of entry.attributes) {
    const type = normalizeAttributeType(candidate.type)
    if (type !== 'thumbnailphoto' && type !== 'jpegphoto') continue

    const firstBuffer = candidate.buffers[0]
    if (firstBuffer && looksLikeImage(firstBuffer)) {
      return { buffer: firstBuffer }
    }

    const values = Array.isArray(candidate.values) ? candidate.values : [candidate.values]
    const first = values[0]
    if (typeof first === 'string') {
      const decoded = decodeMaybeBase64Image(first)
      if (decoded) return { buffer: decoded }
    }
  }

  return undefined
}

function buildAttributeMap(entry: ldap.SearchEntry): Map<string, string[]> {
  const map = new Map<string, string[]>()

  for (const attr of entry.pojo.attributes) {
    const values = Array.isArray(attr.values) ? attr.values.map((value) => String(value)) : []
    map.set(attr.type.toLowerCase(), values)
  }

  return map
}

function pickFirstAttr(map: Map<string, string[]>, name: string): string | undefined {
  const values = map.get(name.toLowerCase())
  const first = values?.[0]
  return first ? String(first) : undefined
}

async function initializeDbPool(): Promise<sql.ConnectionPool> {
  if (dbPool?.connected) return dbPool
  if (dbPoolConnectPromise) return await dbPoolConnectPromise

  dbPoolConnectPromise = (async () => {
    if (dbPool) {
      try {
        await dbPool.close()
      } catch {
      }
      dbPool = undefined
    }

    const pool = new sql.ConnectionPool(getDbConfig())
    await pool.connect()
    dbPool = pool
    return pool
  })()

  try {
    return await dbPoolConnectPromise
  } finally {
    dbPoolConnectPromise = undefined
  }
}

async function getUserPhotoFromDb(staffNo: string): Promise<Buffer | null> {
  try {
    const activePool = await initializeDbPool()
    const request = activePool.request()
    request.input('staffNo', sql.NVarChar, staffNo)

    const result = await request.query<DbPhotoRow>(
      `SELECT PHOTO FROM CardDB WHERE StaffNo = @staffNo AND Del_State = 'False'`
    )
    return result.recordset[0]?.PHOTO ?? null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('Connection is closed')) {
      throw error
    }

    dbPoolConnectPromise = undefined
    if (dbPool) {
      try {
        await dbPool.close()
      } catch {
      }
    }
    dbPool = undefined

    const activePool = await initializeDbPool()
    const request = activePool.request()
    request.input('staffNo', sql.NVarChar, staffNo)
    const result = await request.query<DbPhotoRow>(
      `SELECT PHOTO FROM CardDB WHERE StaffNo = @staffNo AND Del_State = 'False'`
    )
    return result.recordset[0]?.PHOTO ?? null
  }
}

async function getLdapClient(): Promise<ldap.Client> {
  const url = readRequiredEnv('LDAP_URL')
  const bindDN = readRequiredEnv('BIND_DN')
  const bindPW = readRequiredEnv('BIND_PW')

  const client = ldap.createClient({
    url: url.replace('ldap://', 'ldaps://').replace(':389', ':636'),
    tlsOptions: { rejectUnauthorized: false, secureProtocol: 'TLSv1_2_method' },
  })

  client.on('error', (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[ldap:client_error]', message)
  })

  await new Promise<void>((resolve, reject) => {
    client.bind(bindDN, bindPW, (error) => {
      if (error) {
        try {
          client.unbind()
        } catch {
        }
        reject(new Error(`LDAP bind failed: ${formatLdapError(error)}`))
        return
      }
      resolve()
    })
  })

  return client
}

async function searchUserDns(args: {
  client: ldap.Client
  baseDn: string
  filter: string
  sizeLimit: number
}): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    args.client.search(
      args.baseDn,
      {
        scope: 'sub',
        filter: args.filter,
        attributes: ['distinguishedName'],
        sizeLimit: args.sizeLimit,
      },
      (error, result) => {
        if (error) {
          reject(error)
          return
        }

        const dns: string[] = []
        result.on('searchEntry', (entry) => {
          const dn = entry.pojo.objectName
          if (typeof dn === 'string' && dn.trim()) {
            dns.push(dn)
          }
        })
        result.on('error', reject)
        result.on('end', () => resolve(dns))
      }
    )
  })
}

async function searchDns(args: {
  client: ldap.Client
  baseDn: string
  filter: string
  scope: 'sub' | 'one' | 'base'
  sizeLimit: number
}): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    args.client.search(
      args.baseDn,
      {
        scope: args.scope,
        filter: args.filter,
        attributes: ['distinguishedName'],
        sizeLimit: args.sizeLimit,
      },
      (error, result) => {
        if (error) {
          reject(error)
          return
        }

        const dns: string[] = []
        result.on('searchEntry', (entry) => {
          const dn = entry.pojo.objectName
          if (typeof dn === 'string' && dn.trim()) {
            dns.push(dn)
          }
        })
        result.on('error', reject)
        result.on('end', () => resolve(dns))
      }
    )
  })
}

async function searchBitLockerKeys(args: {
  client: ldap.Client
  computerDn: string
}): Promise<BitLockerRecoveryKey[]> {
  return await new Promise<BitLockerRecoveryKey[]>((resolve, reject) => {
    args.client.search(
      args.computerDn,
      {
        scope: 'one',
        filter: '(msFVE-RecoveryPassword=*)',
        attributes: ['msFVE-RecoveryPassword'],
      },
      (error, result) => {
        if (error) {
          reject(error)
          return
        }

        const keys: BitLockerRecoveryKey[] = []
        result.on('searchEntry', (entry) => {
          const dn = entry.pojo.objectName
          const map = buildAttributeMap(entry)
          const password = pickFirstAttr(map, 'msFVE-RecoveryPassword') ?? ''
          if (typeof dn !== 'string' || !dn.trim() || !password) return

          const partitionId = dn.split(',')[0]?.replace(/^CN=/i, '') ?? ''
          if (!partitionId.trim()) return

          keys.push({ partitionId, password })
        })
        result.on('error', reject)
        result.on('end', () => resolve(keys))
      }
    )
  })
}

function parseLapsJson(raw: string): { account: string | null; password: string | null } {
  const trimmed = raw.trim()
  if (!trimmed) return { account: null, password: null }

  try {
    const parsedUnknown: unknown = JSON.parse(trimmed)
    if (!parsedUnknown || typeof parsedUnknown !== 'object') {
      return { account: null, password: null }
    }

    const parsed = parsedUnknown as Record<string, unknown>
    const accountRaw = parsed.n
    const passwordRaw = parsed.p

    return {
      account: typeof accountRaw === 'string' && accountRaw.trim() ? accountRaw.trim() : null,
      password: typeof passwordRaw === 'string' && passwordRaw.trim() ? passwordRaw.trim() : null,
    }
  } catch {
    return { account: null, password: null }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getOptionalEnv(name: string): string | null {
  const value = process.env[name]
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function resolveComputerDn(args: {
  client: ldap.Client
  baseDn: string
  hostname: string
}): Promise<{ ok: true; dn: string } | { ok: false; error: string }> {
  const normalizedHost = args.hostname.trim().toUpperCase()
  if (!normalizedHost) {
    return { ok: false, error: 'Hostname is required.' }
  }

  const escaped = escapeLdapFilterValue(normalizedHost)
  const exactFilter = `(&(objectCategory=computer)(|(cn=${escaped})(sAMAccountName=${escaped}$)))`

  let computerDns = await searchDns({
    client: args.client,
    baseDn: args.baseDn,
    filter: exactFilter,
    scope: 'sub',
    sizeLimit: 2,
  })

  if (computerDns.length < 1) {
    const wildcardFilter = `(&(objectCategory=computer)(cn=${escaped}*))`
    computerDns = await searchDns({
      client: args.client,
      baseDn: args.baseDn,
      filter: wildcardFilter,
      scope: 'sub',
      sizeLimit: 2,
    })
  }

  if (computerDns.length < 1) {
    return { ok: false, error: `Computer "${args.hostname}" not found in AD` }
  }
  if (computerDns.length > 1) {
    return { ok: false, error: `Multiple computer objects matched "${args.hostname}". Provide exact hostname.` }
  }

  return { ok: true, dn: computerDns[0] }
}

async function searchLapsInfo(args: {
  client: ldap.Client
  computerDn: string
  hostname: string
}): Promise<{ info: LapsInfo | null; hasExpirationOnly: boolean }> {
  return await new Promise<{ info: LapsInfo | null; hasExpirationOnly: boolean }>((resolve, reject) => {
    args.client.search(
      args.computerDn,
      {
        scope: 'base',
        filter: '(objectClass=computer)',
        attributes: ['cn', 'msLAPS-Password', 'msLAPS-PasswordExpirationTime', 'ms-Mcs-AdmPwd', 'ms-Mcs-AdmPwdExpirationTime'],
        sizeLimit: 1,
      },
      (error, result) => {
        if (error) {
          reject(error)
          return
        }

        let found: LapsInfo | null = null
        let hasExpirationOnly = false
        result.on('searchEntry', (entry) => {
          const map = buildAttributeMap(entry)
          const cn = pickFirstAttr(map, 'cn') ?? args.hostname

          const msLapsPasswordRaw = pickFirstAttr(map, 'msLAPS-Password')
          const msLapsExpiration = pickFirstAttr(map, 'msLAPS-PasswordExpirationTime')
          if (msLapsExpiration && !msLapsPasswordRaw) {
            hasExpirationOnly = true
          }
          if (msLapsPasswordRaw) {
            const parsed = parseLapsJson(msLapsPasswordRaw)
            if (parsed.password) {
              found = {
                hostname: cn,
                account: parsed.account,
                password: parsed.password,
                source: 'msLAPS-Password',
                expiration: formatWindowsFileTime(msLapsExpiration) ?? null,
              }
              return
            }
          }

          const legacyPassword = pickFirstAttr(map, 'ms-Mcs-AdmPwd')
          const legacyExpiration = pickFirstAttr(map, 'ms-Mcs-AdmPwdExpirationTime')
          if (legacyExpiration && !legacyPassword) {
            hasExpirationOnly = true
          }
          if (legacyPassword?.trim()) {
            found = {
              hostname: cn,
              account: null,
              password: legacyPassword,
              source: 'ms-Mcs-AdmPwd',
              expiration: formatWindowsFileTime(legacyExpiration) ?? null,
            }
          }
        })
        result.on('error', reject)
        result.on('end', () => resolve({ info: found, hasExpirationOnly }))
      }
    )
  })
}

async function searchLapsDiagnostics(args: {
  client: ldap.Client
  computerDn: string
  hostname: string
}): Promise<LapsDiagnostics | null> {
  return await new Promise<LapsDiagnostics | null>((resolve, reject) => {
    args.client.search(
      args.computerDn,
      {
        scope: 'base',
        filter: '(objectClass=computer)',
        attributes: [
          'cn',
          'msLAPS-Password',
          'msLAPS-EncryptedPassword',
          'msLAPS-PasswordExpirationTime',
          'ms-Mcs-AdmPwd',
          'ms-Mcs-AdmPwdExpirationTime',
        ],
        sizeLimit: 1,
      },
      (error, result) => {
        if (error) {
          reject(error)
          return
        }

        let found: LapsDiagnostics | null = null
        result.on('searchEntry', (entry) => {
          const map = buildAttributeMap(entry)
          found = {
            hostname: pickFirstAttr(map, 'cn') ?? args.hostname,
            distinguishedName: args.computerDn,
            visibleAttributes: {
              msLapsPassword: Boolean(pickFirstAttr(map, 'msLAPS-Password')),
              msLapsEncryptedPassword: Boolean(pickFirstAttr(map, 'msLAPS-EncryptedPassword')),
              msLapsPasswordExpirationTime: Boolean(pickFirstAttr(map, 'msLAPS-PasswordExpirationTime')),
              msMcsAdmPwd: Boolean(pickFirstAttr(map, 'ms-Mcs-AdmPwd')),
              msMcsAdmPwdExpirationTime: Boolean(pickFirstAttr(map, 'ms-Mcs-AdmPwdExpirationTime')),
            },
          }
        })
        result.on('error', reject)
        result.on('end', () => resolve(found))
      }
    )
  })
}

async function getLapsInfoFromBridge(hostname: string): Promise<GetLapsInfoResult | null> {
  const endpoint = getOptionalEnv('LAPS_POWERSHELL_URL')
  if (!endpoint) return null

  try {
    const token = getOptionalEnv('LAPS_POWERSHELL_TOKEN')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ hostname }),
    })
    if (!response.ok) {
      const text = await response.text()
      return { success: false, error: `LAPS bridge request failed (${response.status}): ${text || response.statusText}` }
    }

    const dataUnknown: unknown = await response.json()
    if (!isRecord(dataUnknown)) return { success: false, error: 'Invalid LAPS bridge response format.' }
    if (dataUnknown.success !== true) {
      const error = typeof dataUnknown.error === 'string' && dataUnknown.error.trim()
        ? dataUnknown.error
        : 'LAPS bridge returned failure.'
      return { success: false, error }
    }

    const payload = dataUnknown.data
    if (!isRecord(payload)) return { success: false, error: 'Invalid LAPS bridge data payload.' }

    const password = typeof payload.password === 'string' && payload.password.trim() ? payload.password : null
    if (!password) return { success: false, error: 'LAPS bridge returned empty password.' }

    return {
      success: true,
      data: {
        hostname: typeof payload.hostname === 'string' && payload.hostname.trim() ? payload.hostname : hostname,
        account: typeof payload.account === 'string' && payload.account.trim() ? payload.account : null,
        password,
        source: 'powershell-bridge',
        expiration: typeof payload.expiration === 'string' && payload.expiration.trim() ? payload.expiration : null,
      },
    }
  } catch (error) {
    return {
      success: false,
      error: `LAPS bridge error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function resolveUserDn(args: { client: ldap.Client; identifier: string }): Promise<ResolveUserDnResult> {
  const identifier = args.identifier.trim()
  if (!identifier) return { ok: false, error: 'User identifier is required.' }
  if (identifier.includes(',')) return { ok: true, dn: identifier }

  const baseDn = readBaseDn()
  if (!baseDn) {
    return { ok: false, error: 'BASE_DN (or LDAP_BASE_DN / BASE_OU) must be set in environment.' }
  }

  const escaped = escapeLdapFilterValue(identifier)
  const exactFilter = `(&(|(sAMAccountName=${escaped})(userPrincipalName=${escaped})(mail=${escaped})(cn=${escaped}))(objectCategory=person)(objectClass=user))`
  const exactDns = await searchUserDns({ client: args.client, baseDn, filter: exactFilter, sizeLimit: 2 })
  if (exactDns.length === 1) return { ok: true, dn: exactDns[0] }
  if (exactDns.length > 1) return { ok: false, error: 'Multiple users matched. Provide full DN to disambiguate.' }

  const shouldTryMailAlias = !identifier.includes('@') && identifier.includes('.')
  if (shouldTryMailAlias) {
    const aliasFilter = `(&(|(userPrincipalName=${escaped}@*)(mail=${escaped}@*)(proxyAddresses=smtp:${escaped}@*)(proxyAddresses=SMTP:${escaped}@*)(mailNickname=${escaped}))(objectCategory=person)(objectClass=user))`
    const aliasDns = await searchUserDns({ client: args.client, baseDn, filter: aliasFilter, sizeLimit: 2 })
    if (aliasDns.length === 1) return { ok: true, dn: aliasDns[0] }
    if (aliasDns.length > 1) return { ok: false, error: 'Multiple users matched. Provide full DN to disambiguate.' }

    const tokenPattern = identifier
      .split('.')
      .filter(Boolean)
      .map(escapeLdapFilterValue)
      .join('*')
    const tokensFilter = `(&(|(cn=*${tokenPattern}*)(displayName=*${tokenPattern}*))(objectCategory=person)(objectClass=user))`
    const tokenDns = await searchUserDns({ client: args.client, baseDn, filter: tokensFilter, sizeLimit: 2 })
    if (tokenDns.length === 1) return { ok: true, dn: tokenDns[0] }
    if (tokenDns.length > 1) return { ok: false, error: 'Multiple users matched. Provide full DN to disambiguate.' }
  }

  const likeFilter = `(&(|(sAMAccountName=*${escaped}*)(userPrincipalName=*${escaped}*)(mail=*${escaped}*)(cn=*${escaped}*)(displayName=*${escaped}*))(objectCategory=person)(objectClass=user))`
  const likeDns = await searchUserDns({ client: args.client, baseDn, filter: likeFilter, sizeLimit: 5 })
  if (likeDns.length === 1) return { ok: true, dn: likeDns[0] }
  if (likeDns.length > 1) return { ok: false, error: 'Multiple users matched. Provide full DN to disambiguate.' }

  return { ok: false, error: 'User not found.' }
}

function buildFindUserCaption(user: FindUserRecord, includePhoto: boolean): string {
  const lastSet = formatWindowsFileTime(user.pwdLastSet) ?? 'Unknown'
  const expiryDate = formatWindowsFileTime(user.passwordExpiryTimeComputed)
  const expiryText =
    user.passwordExpiryTimeComputed && expiryDate && !isExceptionallyLongDateString(expiryDate)
      ? `Password Expired on: ${expiryDate}`
      : 'Password never expires'
  const photoStatus = includePhoto ? (user.photoBuffer ? ' 📷' : ' (No photo available)') : ''

  return (
    `*${user.displayName}* [MTI]${photoStatus}\n` +
    `📧 ${user.userPrincipalName ?? user.mail ?? 'Not available'}\n` +
    `🏷️ ${user.title ?? 'Not available'}\n` +
    `🏢 ${user.department ?? 'Not available'}\n` +
    `📱 ${user.mobile ?? user.telephoneNumber ?? 'Not available'}\n` +
    (user.employeeID ? `🆔 ${user.employeeID}\n` : '') +
    `🔒 Last Pass Change: ${lastSet}\n` +
    `⏳ ${expiryText}`
  )
}

export function renderFindUserCaption(args: { user: FindUserRecord; includePhoto: boolean }): {
  caption: string
  hasPhoto: boolean
  photoBuffer?: Buffer
  photoContentType?: string
} {
  return {
    caption: buildFindUserCaption(args.user, args.includePhoto),
    hasPhoto: Boolean(args.includePhoto && args.user.photoBuffer),
    photoBuffer: args.user.photoBuffer,
    photoContentType: args.user.photoContentType,
  }
}

export async function findUserMobileByEmail(args: { email: string }): Promise<string | null> {
  const email = args.email.trim().toLowerCase()
  if (!email) return null

  const baseDn = readBaseDn()
  if (!baseDn) return null

  let client: ldap.Client
  try {
    client = await getLdapClient()
  } catch {
    return null
  }

  const escaped = escapeLdapFilterValue(email)
  const filter = `(&(mail=${escaped}))`

  try {
    const mobile = await new Promise<string | null>((resolve, reject) => {
      client.search(
        baseDn,
        {
          scope: 'sub',
          filter,
          attributes: ['mobile', 'mobileNumber', 'telephoneNumber'],
          sizeLimit: 1,
        },
        (error, result) => {
          if (error) {
            reject(error)
            return
          }

          let value: string | null = null
          result.on('searchEntry', (entry) => {
            if (value) return
            const map = buildAttributeMap(entry)
            value =
              pickFirstAttr(map, 'mobile') ??
              pickFirstAttr(map, 'mobileNumber') ??
              pickFirstAttr(map, 'telephoneNumber') ??
              null
          })
          result.on('error', reject)
          result.on('end', () => resolve(value))
        }
      )
    })

    client.unbind()
    return mobile
  } catch {
    client.unbind()
    return null
  }
}

export class LdapService {
  async findUsersByCommonName(args: { query: string; includePhoto: boolean }): Promise<FindUsersResult> {
    const baseDn = readBaseDn()
    if (!baseDn) {
      return {
        success: false,
        error: 'BASE_DN (or LDAP_BASE_DN / BASE_OU) must be set in environment.',
      }
    }

    const minQueryLen = Number(process.env.LDAP_FINDUSER_MIN_QUERY_LEN ?? '3')
    const cleanedQuery = args.query.trim()
    if (cleanedQuery.length < Math.max(1, Math.floor(minQueryLen))) {
      return {
        success: false,
        error: `Query too short. Provide at least ${Math.max(1, Math.floor(minQueryLen))} characters.`,
      }
    }

    const timeoutMs = Number(process.env.LDAP_FINDUSER_TIMEOUT ?? process.env.LDAP_TIMEOUT ?? '10000')
    const sizeLimit = Number(process.env.LDAP_FINDUSER_SIZE_LIMIT ?? '25')
    const timeLimitSeconds = Number(process.env.LDAP_FINDUSER_TIME_LIMIT_SECONDS ?? '10')

    let client: ldap.Client | null = null
    try {
      client = await getLdapClient()
      const escaped = escapeLdapFilterValue(cleanedQuery.toLowerCase())
      const filter =
        `(&` +
        `(|(cn=*${escaped}*)(displayName=*${escaped}*)(sAMAccountName=*${escaped}*)(userPrincipalName=*${escaped}*))` +
        `(objectCategory=person)(objectClass=user)` +
        `)`

      const attributesBase = [
        'displayName',
        'userPrincipalName',
        'mail',
        'title',
        'department',
        'mobile',
        'mobileNumber',
        'telephoneNumber',
        'employeeID',
        'pwdLastSet',
        'msDS-UserPasswordExpiryTimeComputed',
        'cn',
      ]
      const attributes = args.includePhoto ? [...attributesBase, 'thumbnailPhoto', 'jpegPhoto'] : attributesBase

      const users: FindUserRecord[] = []
      const photoFetches: Array<Promise<void>> = []
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('LDAP search timeout'))
        }, timeoutMs)

        client!.search(
          baseDn,
          {
            scope: 'sub',
            filter,
            attributes,
            sizeLimit: Math.max(1, Math.floor(sizeLimit)),
            timeLimit: Math.max(1, Math.floor(timeLimitSeconds)),
          },
          (error, result) => {
            if (error) {
              clearTimeout(timer)
              reject(error)
              return
            }

            result.on('searchEntry', (entry) => {
              const map = buildAttributeMap(entry)
              const user: FindUserRecord = {
                displayName:
                  pickFirstAttr(map, 'displayName') ??
                  pickFirstAttr(map, 'cn') ??
                  pickFirstAttr(map, 'name') ??
                  pickFirstAttr(map, 'sAMAccountName') ??
                  pickFirstAttr(map, 'userPrincipalName') ??
                  'Unknown',
                userPrincipalName: pickFirstAttr(map, 'userPrincipalName'),
                mail: pickFirstAttr(map, 'mail'),
                title: pickFirstAttr(map, 'title'),
                department: pickFirstAttr(map, 'department'),
                mobile: pickFirstAttr(map, 'mobile') ?? pickFirstAttr(map, 'mobileNumber'),
                telephoneNumber: pickFirstAttr(map, 'telephoneNumber'),
                employeeID: pickFirstAttr(map, 'employeeID'),
                pwdLastSet: pickFirstAttr(map, 'pwdLastSet'),
                passwordExpiryTimeComputed: pickFirstAttr(map, 'msDS-UserPasswordExpiryTimeComputed'),
              }

              if (args.includePhoto) {
                const photo = extractPhotoFromEntry(entry)
                if (photo) {
                  user.photoBuffer = photo.buffer
                  user.photoContentType = photo.contentType
                } else if (user.employeeID) {
                  const employeeId = user.employeeID
                  photoFetches.push(
                    (async () => {
                      try {
                        const dbPhoto = await getUserPhotoFromDb(employeeId)
                        if (dbPhoto && looksLikeImage(dbPhoto)) {
                          user.photoBuffer = dbPhoto
                        }
                      } catch {
                      }
                    })()
                  )
                }
              }

              users.push(user)
            })

            result.on('error', (searchError) => {
              clearTimeout(timer)
              reject(searchError)
            })

            result.on('end', () => {
              clearTimeout(timer)
              resolve()
            })
          }
        )
      })

        if (photoFetches.length > 0) {
          await Promise.all(photoFetches)
        }

      return { success: true, users }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      try {
        client?.unbind()
      } catch {
      }
    }
  }

    async getBitLockerInfo(args: { hostname: string }): Promise<GetBitLockerInfoResult> {
      const hostname = args.hostname.trim()
      if (!hostname) {
        return { success: false, error: 'Hostname is required.' }
      }

      const baseDn = readBaseDn()
      if (!baseDn) {
        return {
          success: false,
          error: 'LDAP_BASE_DN (or BASE_DN / BASE_OU) must be set in environment.',
        }
      }

      let client: ldap.Client | null = null
      try {
        client = await getLdapClient()
        const normalizedHost = hostname.toUpperCase()
        const escaped = escapeLdapFilterValue(normalizedHost)
        const exactFilter = `(&(objectCategory=computer)(|(cn=${escaped})(sAMAccountName=${escaped}$)))`

        let computerDns = await searchDns({
          client,
          baseDn,
          filter: exactFilter,
          scope: 'sub',
          sizeLimit: 2,
        })
        if (computerDns.length < 1) {
          const wildcardFilter = `(&(objectCategory=computer)(cn=${escaped}*))`
          computerDns = await searchDns({
            client,
            baseDn,
            filter: wildcardFilter,
            scope: 'sub',
            sizeLimit: 2,
          })
        }

        if (computerDns.length < 1) {
          return { success: false, error: `Computer "${hostname}" not found in AD` }
        }
        if (computerDns.length > 1) {
          return { success: false, error: `Multiple computer objects matched "${hostname}". Provide exact hostname.` }
        }

        const keys = await searchBitLockerKeys({ client, computerDn: computerDns[0] })
        if (keys.length < 1) {
          return { success: false, error: 'No BitLocker recovery objects found' }
        }

        return {
          success: true,
          data: {
            hostname,
            keys,
          },
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      } finally {
        try {
          client?.unbind()
        } catch {
        }
      }
    }

    async getLapsInfo(args: { hostname: string }): Promise<GetLapsInfoResult> {
      const hostname = args.hostname.trim()
      if (!hostname) {
        return { success: false, error: 'Hostname is required.' }
      }

      const baseDn = readBaseDn()
      if (!baseDn) {
        return {
          success: false,
          error: 'LDAP_BASE_DN (or BASE_DN / BASE_OU) must be set in environment.',
        }
      }

      let client: ldap.Client | null = null
      try {
        client = await getLdapClient()
        const resolved = await resolveComputerDn({ client, baseDn, hostname })
        if (!resolved.ok) {
          return { success: false, error: resolved.error }
        }

        const laps = await searchLapsInfo({ client, computerDn: resolved.dn, hostname })
        if (!laps.info) {
          const bridged = await getLapsInfoFromBridge(hostname)
          if (bridged) return bridged

          if (laps.hasExpirationOnly) {
            return {
              success: false,
              error:
                'LAPS is configured for this host, but password attributes are not readable by current bind account. Grant read access to msLAPS-Password or ms-Mcs-AdmPwd.',
            }
          }

          return {
            success: false,
            error: 'No LAPS password found. Ensure msLAPS-Password or ms-Mcs-AdmPwd is readable for this account.',
          }
        }

        return { success: true, data: laps.info }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      } finally {
        try {
          client?.unbind()
        } catch {
        }
      }
    }

    async getLapsDiagnostics(args: { hostname: string }): Promise<GetLapsDiagnosticsResult> {
      const hostname = args.hostname.trim()
      if (!hostname) {
        return { success: false, error: 'Hostname is required.' }
      }

      const baseDn = readBaseDn()
      if (!baseDn) {
        return {
          success: false,
          error: 'LDAP_BASE_DN (or BASE_DN / BASE_OU) must be set in environment.',
        }
      }

      let client: ldap.Client | null = null
      try {
        client = await getLdapClient()
        const resolved = await resolveComputerDn({ client, baseDn, hostname })
        if (!resolved.ok) {
          return { success: false, error: resolved.error }
        }

        const diagnostics = await searchLapsDiagnostics({ client, computerDn: resolved.dn, hostname })
        if (!diagnostics) {
          return { success: false, error: 'Failed to inspect LAPS attributes.' }
        }

        return { success: true, data: diagnostics }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      } finally {
        try {
          client?.unbind()
        } catch {
        }
      }
    }

  async resetPassword(args: {
    username: string
    newPassword: string
    changePasswordAtNextLogon: boolean
  }): Promise<ResetPasswordResult> {
    let client: ldap.Client | null = null

    try {
      client = await getLdapClient()
      const resolved = await resolveUserDn({ client, identifier: args.username })
      if (!resolved.ok) {
        return {
          success: false,
          error: `${resolved.error} Provide full DN or set BASE_DN/LDAP_BASE_DN/BASE_OU correctly.`,
        }
      }

      const changes: ldap.Change[] = [
        new ldap.Change({
          operation: 'replace',
          modification: {
            type: 'unicodePwd',
            values: [Buffer.from(`"${args.newPassword}"`, 'utf16le')],
          },
        }),
      ]

      if (args.changePasswordAtNextLogon) {
        changes.push(
          new ldap.Change({
            operation: 'replace',
            modification: {
              type: 'pwdLastSet',
              values: ['0'],
            },
          })
        )
      }

      const changeTypes = ['unicodePwd']
      if (args.changePasswordAtNextLogon) {
        changeTypes.push('pwdLastSet')
      }

      for (const [index, change] of changes.entries()) {
        await new Promise<void>((resolve, reject) => {
          client!.modify(resolved.dn, change, (error) => {
            if (error) {
              const changeType = changeTypes[index] ?? 'unknown'
              console.error(
                '[ldap:modify_failed]',
                JSON.stringify({
                  dn: resolved.dn,
                  changeType,
                  message: formatLdapError(error),
                })
              )
              reject(new Error(`LDAP modify failed for ${changeType}: ${formatLdapError(error)}`))
              return
            }
            resolve()
          })
        })
      }

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      try {
        client?.unbind()
      } catch {
      }
    }
  }

  async unlockAccount(args: { username: string }): Promise<UnlockAccountResult> {
    let client: ldap.Client | null = null

    try {
      client = await getLdapClient()
      const resolved = await resolveUserDn({ client, identifier: args.username })
      if (!resolved.ok) {
        return {
          success: false,
          error: `${resolved.error} Provide full DN or set BASE_DN/LDAP_BASE_DN/BASE_OU correctly.`,
        }
      }

      const change = new ldap.Change({
        operation: 'replace',
        modification: {
          type: 'lockoutTime',
          values: ['0'],
        },
      })

      await new Promise<void>((resolve, reject) => {
        client!.modify(resolved.dn, change, (error) => {
          if (error) {
            console.error(
              '[ldap:modify_failed]',
              JSON.stringify({
                dn: resolved.dn,
                changeType: 'lockoutTime',
                message: formatLdapError(error),
              })
            )
            reject(new Error(`LDAP modify failed for lockoutTime: ${formatLdapError(error)}`))
            return
          }
          resolve()
        })
      })

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      try {
        client?.unbind()
      } catch {
      }
    }
  }
}
