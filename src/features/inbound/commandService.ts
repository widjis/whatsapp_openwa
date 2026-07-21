import path from 'node:path'
import type { MessagingService } from '../channel/messagingService.js'
import type { DirectoryService } from '../channel/directoryService.js'
import type { InboundMessageEvent, ReactionEvent } from '../channel/eventNormalizer.js'
import { findUserMobileByEmail, renderFindUserCaption, type LdapService } from '../integrations/ldap.js'
import { buildTicketLink, updateRequest, viewRequest } from '../integrations/serviceDesk.js'
import {
  addTechnicianContact,
  deleteTechnicianContact,
  getContactByPhone,
  getTechnicianContactById,
  getTechnicianContactsPath,
  listTechnicianContacts,
  type TechnicianContact,
  type TechnicianContactUpdateField,
  searchTechnicianContacts,
  updateTechnicianContact,
} from '../integrations/technicianContacts.js'
import { claimTicketNotification, loadTicketNotification, unclaimTicketNotification } from '../tickets/claimStore.js'
import {
  buildGetAssetReply,
  getExpiringLicenses,
  getLicenseByName,
  getLicenses,
  getLicenseUtilization,
} from '../integrations/snipeIt.js'
import {
  buildLeaveScheduleIndexForDate,
  getTodayIsoDateForOffsetHours,
  normalizeScheduleBaseName,
  resolveLeaveScheduleEntry,
} from '../../leaveScheduleCheck.js'
import { extractDigitsFromJid, normalizePhoneDigits, phoneNumberFormatter } from '../../utils/phone.js'

type CommandReply =
  | {
      kind: 'text'
      text: string
    }
  | {
      kind: 'image'
      caption: string
      buffer: Buffer
      mimetype?: string
      filename?: string
    }

type CommandHandleResult = {
  handled: boolean
  commandName?: string
  replies?: CommandReply[]
}

type DebugValue = string | number | boolean | null | undefined
type LeaveMappingMode = 'exact' | 'pattern' | 'fuzzy'
type ReactionAction = 'claim' | 'unclaim'

type LeaveMappingResolution = {
  matchedKey: string
  mode: LeaveMappingMode
}

type LeaveMappingItem = {
  id: number
  ictName: string
  value: string
  mode: LeaveMappingMode
}

const DEBUG_LAPS_AUTH = process.env.DEBUG_LAPS_AUTH === 'true'
const recentReactionEvents = new Map<string, number>()

type CommandHelpEntry = {
  usage: string
  description: string
  details?: string
  available?: string
  examples?: string[]
}

const HELP_TEXT =
  `*Available Commands:*\n`
  + `\n*General:*\n`
  + `- /hi\n`
  + `- /ping\n`
  + `- /help\n`
  + `- /help <command>\n`
  + `\n*User (Active Directory):*\n`
  + `- /finduser\n`
  + `- /resetpassword\n`
  + `- /unlock\n`
  + `\n*System:*\n`
  + `- /getasset\n`
  + `- /getbitlocker\n`
  + `- /getlaps\n`
  + `- /getlapsdiag\n`
  + `- /setlaps\n`
  + `\n*Licenses:*\n`
  + `- /licenses\n`
  + `- /getlicense\n`
  + `- /expiring\n`
  + `- /licensereport\n`
  + `\n*Operations:*\n`
  + `- /technician\n`
  + `\n*Example:*\n`
  + `- /help finduser`

const COMMAND_HELP: Record<string, CommandHelpEntry> = {
  hi: {
    usage: '/hi',
    description: 'Simple connectivity check.',
  },
  ping: {
    usage: '/ping',
    description: 'Simple connectivity check (returns pong).',
  },
  help: {
    usage: '/help [command]',
    description: 'Shows available commands or detailed help for one command.',
    examples: ['/help', '/help finduser', '/help /resetpassword'],
  },
  finduser: {
    usage: '/finduser <name> [/photo]',
    description: 'Finds users in Active Directory by display name (CN).',
    details:
      'Searches by partial match on common name (CN). Returns display name, email, title, department, phone, and password info. Add `/photo` to include the user photo if available in AD.',
    examples: ['/finduser peggy', '/finduser "john doe"', '/finduser peggy /photo'],
  },
  resetpassword: {
    usage: '/resetpassword <username> <new_password> [/change]',
    description:
      'Resets the password for the given username. Optionally, use the `/change` flag to require the user to change their password at the next logon.',
    examples: ['/resetpassword johndoe newpassword123', '/resetpassword johndoe newpassword123 /change'],
  },
  unlock: {
    usage: '/unlock <username>',
    description: 'Unlocks an Active Directory user account (clears lockout).',
    examples: ['/unlock johndoe', '/unlock john.doe'],
  },
  getbitlocker: {
    usage: '/getbitlocker <hostname>',
    description: 'Retrieves BitLocker recovery keys for the specified hostname from Active Directory.',
    examples: ['/getbitlocker mti-nb-123'],
  },
  getasset: {
    usage: '/getasset [type]',
    description: 'Summarizes assets from Snipe-IT by category.',
    examples: ['/getasset', '/getasset pc', '/getasset notebook', '/getasset monitor'],
  },
  getlaps: {
    usage: '/getlaps <hostname>',
    description: 'Retrieves LAPS local admin account and current password for the specified hostname.',
    details:
      'For security, use this in private chat. Access is granted to LAPS admins (LAPS_ADMIN_PHONE_NUMBERS) and technicians with laps_access=true in technician contacts.',
    examples: ['/getlaps mti-nb-123'],
  },
  getlapsdiag: {
    usage: '/getlapsdiag <hostname>',
    description: 'Shows which LAPS LDAP attributes are visible to the bot account for a hostname.',
    details:
      'Diagnostic command only. Does not return passwords. Access is granted to LAPS admins (LAPS_ADMIN_PHONE_NUMBERS) and technicians with laps_access=true in technician contacts.',
    examples: ['/getlapsdiag mti-nb-123'],
  },
  setlaps: {
    usage: '/setlaps technician <id> /a|/d',
    description: 'Grants or revokes LAPS access for a technician.',
    details: 'Admin-only. Updates technician contacts laps_access flag. Use /a to allow and /d to deny.',
    examples: ['/setlaps technician 7 /a', '/setlaps technician 7 /d'],
  },
  licenses: {
    usage: '/licenses [limit] [offset]',
    description: 'Lists all software licenses with pagination support.',
    details:
      'Retrieves licenses from Snipe-IT asset management system. Default limit is 50 licenses per page. Use offset for pagination.',
    examples: ['/licenses', '/licenses 10', '/licenses 10 0'],
  },
  getlicense: {
    usage: '/getlicense <name_or_id>',
    description: 'Gets detailed information about a specific license by name or ID.',
    details:
      'Searches for licenses by exact name match or ID. Returns details including manufacturer, purchase information, seat allocation, and expiration dates.',
    examples: ['/getlicense Microsoft Office', '/getlicense 123', '/getlicense "Adobe Creative Suite"'],
  },
  expiring: {
    usage: '/expiring [days]',
    description: 'Lists licenses expiring within specified number of days (default: 30).',
    details: 'Shows license name, usage, total seats, and days until expiration.',
    examples: ['/expiring', '/expiring 30', '/expiring 90'],
  },
  licensereport: {
    usage: '/licensereport',
    description: 'Generates a comprehensive license utilization report with statistics.',
    examples: ['/licensereport'],
  },
  technician: {
    usage: '/technician <command> [parameters]',
    description: 'Technician contact management (CRUD + leave mapping).',
    available:
      'Commands:\n- list\n- search <query>\n- view <id>\n- add "Name" "ICT Name" "Phone" "Email" "Role" "Gender"\n- update <id> "field" "value"\n- delete <id>\n- mapleave',
    examples: [
      '/technician list',
      '/technician search Peggy',
      '/technician view 5',
      '/technician add "Ahmad Rizki" "Ahmad Rizki (Network Admin)" "08123456789" "ahmad.rizki@company.com" "Network Administrator" "Male"',
      '/technician update 3 "phone" "08987654321"',
      '/technician delete 8',
      '/technician mapleave',
    ],
  },
}

function renderCommandHelp(commandKey: string): string | undefined {
  const details = COMMAND_HELP[commandKey]
  if (!details) return undefined

  let helpText = `*Usage:* ${details.usage}\n*Description:* ${details.description}`
  if (details.details) helpText += `\n*Details:* ${details.details}`
  if (details.available) helpText += `\n*Available:* ${details.available}`
  if (details.examples && details.examples.length > 0) {
    helpText += `\n*Example(s):*\n${details.examples.join('\n')}`
  }
  return helpText
}

function truncate(value: string, maxLength = 120): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 3) return value.slice(0, maxLength)
  return `${value.slice(0, maxLength - 3)}...`
}

function stripHtmlToText(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function getRequesterLabel(request: { requester?: { name?: string; email_id?: string } | null }): string {
  const name = request.requester?.name?.trim()
  const email = request.requester?.email_id?.trim()
  if (name && email) return `${name} (${email})`
  if (name) return name
  if (email) return email
  return 'Unknown requester'
}

function formatDebugValue(value: DebugValue): string {
  if (value === undefined) return '-'
  if (value === null) return '<null>'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (!text) return '""'
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

function formatDebugPairs(details: Record<string, DebugValue>, preferredOrder: string[] = []): string {
  const keys = new Set<string>([...preferredOrder, ...Object.keys(details)])
  return Array.from(keys)
    .filter((key) => key in details)
    .map((key) => `${key}=${formatDebugValue(details[key])}`)
    .join(' | ')
}

function textReply(text: string): CommandReply {
  return { kind: 'text', text }
}

function parseEnvPhoneList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => normalizePhoneDigits(value))
    .filter(Boolean)
}

function parseReactionGroupIds(): Set<string> {
  return new Set(
    (process.env.TICKET_REACTION_GROUP_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => (value.includes('@') ? value : `${value}@g.us`))
  )
}

function buildReactionEventKey(args: {
  chatId: string
  messageId: string
  senderId: string
  reactionText: string | null
}): string {
  return [args.chatId, args.messageId, args.senderId, args.reactionText ?? '<removed>'].join('|')
}

function shouldProcessReactionEvent(key: string): boolean {
  const now = Date.now()
  for (const [existingKey, timestamp] of recentReactionEvents) {
    if (now - timestamp > 15_000) recentReactionEvents.delete(existingKey)
  }

  const last = recentReactionEvents.get(key)
  if (typeof last === 'number' && now - last <= 15_000) return false
  recentReactionEvents.set(key, now)
  return true
}

function splitCommandLine(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (!char) continue

    if (quote) {
      if (char === quote) {
        quote = null
        continue
      }
      current += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) tokens.push(current)
      current = ''
      continue
    }

    current += char
  }

  if (current) tokens.push(current)
  return tokens
}

function maskPhoneForLogs(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length <= 4) return digits
  return `${digits.slice(0, 3)}***${digits.slice(-2)}`
}

function debugLapsAuth(event: string, details: Record<string, DebugValue>): void {
  if (!DEBUG_LAPS_AUTH) return
  try {
    console.log('[laps-auth]', JSON.stringify({ event, ...details }))
  } catch {
    console.log('[laps-auth]', event)
  }
}

function formatBitLockerDate(partitionId: string): string {
  const match = partitionId.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/)
  if (!match) return 'Unknown'

  const [, year, month, day, hour, minute, second] = match
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  )
  if (Number.isNaN(date.getTime())) return 'Unknown'

  return (
    date
      .toLocaleString('en-GB', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
      .replace(',', '') + ' WIB'
  )
}

function formatTwoColumnRows(rows: Array<{ label: string; value: string }>): string {
  const maxLabel = rows.reduce((max, row) => Math.max(max, row.label.length), 0)
  return rows.map((row) => `${row.label.padEnd(maxLabel)}  ${row.value}`).join('\n')
}

function renderTechnicianDetails(contact: TechnicianContact): string {
  const rows = formatTwoColumnRows([
    { label: 'ID', value: String(contact.id) },
    { label: 'Name', value: contact.name },
    { label: 'ICT Name', value: contact.ict_name },
    { label: 'Leave Schedule', value: contact.leave_schedule_name ?? 'N/A' },
    { label: 'Role', value: contact.technician },
    { label: 'LAPS Access', value: contact.laps_access === true ? 'yes' : 'no' },
    { label: 'Phone', value: contact.phone },
    { label: 'Email', value: contact.email ?? 'N/A' },
    { label: 'Gender', value: contact.gender ?? 'N/A' },
  ])
  return `\`\`\`\n${rows}\n\`\`\``
}

function renderTechnicianTable(contacts: TechnicianContact[]): string {
  const rows = contacts.map((contact) => ({
    id: String(contact.id),
    name: truncateText(contact.name, 28),
    role: truncateText(contact.technician, 28),
    phone: truncateText(contact.phone, 18),
    laps: contact.laps_access === true ? 'yes' : 'no',
  }))

  const maxId = Math.max(2, ...rows.map((row) => row.id.length))
  const maxName = Math.max(4, ...rows.map((row) => row.name.length))
  const maxRole = Math.max(4, ...rows.map((row) => row.role.length))
  const maxPhone = Math.max(5, ...rows.map((row) => row.phone.length))
  const maxLaps = Math.max(4, ...rows.map((row) => row.laps.length))

  const header =
    `${'ID'.padEnd(maxId)}  ${'Name'.padEnd(maxName)}  ` +
    `${'Role'.padEnd(maxRole)}  ${'Phone'.padEnd(maxPhone)}  ${'LAPS'.padEnd(maxLaps)}`
  const lines = rows.map(
    (row) =>
      `${row.id.padEnd(maxId)}  ${row.name.padEnd(maxName)}  ${row.role.padEnd(maxRole)}  ${row.phone.padEnd(maxPhone)}  ${row.laps.padEnd(maxLaps)}`
  )

  return `\`\`\`\n${[header, ...lines].join('\n')}\n\`\`\``
}

function isUpdateField(value: string): value is TechnicianContactUpdateField {
  return (
    value === 'name' ||
    value === 'ict_name' ||
    value === 'leave_schedule_name' ||
    value === 'phone' ||
    value === 'email' ||
    value === 'technician' ||
    value === 'gender' ||
    value === 'laps_access'
  )
}

function parseBoolean(input: string | undefined, defaultValue: boolean): boolean {
  if (!input) return defaultValue
  const normalized = input.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return defaultValue
}

function parseNumber(input: string | undefined, defaultValue: number): number {
  if (!input) return defaultValue
  const value = Number(input)
  return Number.isFinite(value) ? value : defaultValue
}

function resolvePatternCandidate(args: { scheduleKeys: string[]; sourceName: string }): string | null {
  const sourceKey = normalizeScheduleBaseName(args.sourceName)
  if (!sourceKey) return null

  const tokens = sourceKey
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
  if (tokens.length === 0) return null

  const matches: string[] = []
  for (const key of args.scheduleKeys) {
    const keyTokens = key.split(/\s+/)
    const keySet = new Set(keyTokens)
    const matched = tokens.every((token) => {
      if (keySet.has(token)) return true
      return keyTokens.some((keyToken) => isTokenLikelyTypoMatch(token, keyToken))
    })
    if (matched) matches.push(key)
  }

  return matches.length === 1 ? matches[0] : null
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  const previous = new Array<number>(b.length + 1)
  const current = new Array<number>(b.length + 1)

  for (let index = 0; index <= b.length; index += 1) previous[index] = index

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j]
  }

  return previous[b.length]
}

function isTokenLikelyTypoMatch(sourceToken: string, candidateToken: string): boolean {
  if (sourceToken.length < 5 || candidateToken.length < 5) return false
  if (Math.abs(sourceToken.length - candidateToken.length) > 1) return false
  return levenshteinDistance(sourceToken, candidateToken) <= 1
}

function resolveLeaveMappingForContact(args: {
  scheduleIndex: Map<string, { status: string | null; onsite: boolean }>
  scheduleKeys: string[]
  sourceName: string
  allowFuzzy: boolean
  similarityThreshold: number
}): LeaveMappingResolution | null {
  const sourceKey = normalizeScheduleBaseName(args.sourceName)
  if (!sourceKey) return null
  if (args.scheduleIndex.has(sourceKey)) return { matchedKey: sourceKey, mode: 'exact' }

  const pattern = resolvePatternCandidate({ scheduleKeys: args.scheduleKeys, sourceName: args.sourceName })
  if (pattern) return { matchedKey: pattern, mode: 'pattern' }

  const fuzzy = resolveLeaveScheduleEntry({
    scheduleIndex: args.scheduleIndex,
    personName: args.sourceName,
    allowFuzzy: args.allowFuzzy,
    similarityThreshold: args.similarityThreshold,
  })
  if (!fuzzy) return null
  return { matchedKey: fuzzy.matchedKey, mode: 'fuzzy' }
}

function determineLeaveScheduleMapping(): {
  changed: LeaveMappingItem[]
  skippedExisting: number
  unresolved: Array<{ id: number; ictName: string }>
  dateIso: string
  xlsxPath: string
  sheetName: string
} {
  const dataDir = process.env.DATA_DIR?.trim() || path.resolve(process.cwd(), 'data')
  const xlsxPath =
    process.env.DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH?.trim() || path.join(dataDir, 'MTI - Leave Schedule (ICT Team).xlsx')
  const sheetName = process.env.DISPATCHER_LEAVE_SCHEDULE_SHEET?.trim() || 'Human Resource'
  const tzOffsetHours = Math.floor(parseNumber(process.env.DISPATCHER_LEAVE_SCHEDULE_TZ_OFFSET_HOURS, 8))
  const dateShiftDays = Math.floor(parseNumber(process.env.DISPATCHER_LEAVE_SCHEDULE_DATE_SHIFT_DAYS, 1))
  const similarityThreshold = Math.min(1, Math.max(0, parseNumber(process.env.DISPATCHER_LEAVE_SCHEDULE_SIM_THRESHOLD, 0.9)))
  const allowFuzzy = parseBoolean(process.env.DISPATCHER_LEAVE_SCHEDULE_FUZZY, true)
  const dateIso = getTodayIsoDateForOffsetHours(tzOffsetHours)

  const scheduleIndex = buildLeaveScheduleIndexForDate({
    xlsxPath,
    sheetName,
    dateIsoYyyyMmDd: dateIso,
    dateHeaderRow1Based: 9,
    dataStartRow1Based: 10,
    dateShiftDays,
  })
  const scheduleKeys = Array.from(scheduleIndex.keys())
  const contacts = listTechnicianContacts()
  const nextContacts = contacts.slice()
  const changed: LeaveMappingItem[] = []
  let skippedExisting = 0
  const unresolved: Array<{ id: number; ictName: string }> = []

  for (let index = 0; index < nextContacts.length; index += 1) {
    const contact = nextContacts[index]
    const existing = typeof contact.leave_schedule_name === 'string' ? contact.leave_schedule_name.trim() : ''
    if (existing.length > 0) {
      skippedExisting += 1
      continue
    }

    const sourceName = contact.ict_name || contact.name
    const mapped = resolveLeaveMappingForContact({
      scheduleIndex,
      scheduleKeys,
      sourceName,
      allowFuzzy,
      similarityThreshold,
    })

    if (!mapped) {
      unresolved.push({ id: contact.id, ictName: contact.ict_name })
      continue
    }

    nextContacts[index] = { ...contact, leave_schedule_name: mapped.matchedKey }
    changed.push({
      id: contact.id,
      ictName: contact.ict_name,
      value: mapped.matchedKey,
      mode: mapped.mode,
    })
  }

  for (const changedContact of changed) {
    updateTechnicianContact(changedContact.id, 'leave_schedule_name', changedContact.value)
  }

  return {
    changed,
    skippedExisting,
    unresolved,
    dateIso,
    xlsxPath,
    sheetName,
  }
}

function determineServiceDeskGroupByRole(role: string): string {
  const normalized = role.toLowerCase()
  if (normalized.includes('document control')) return 'ICT Document Controller'
  if (normalized.includes('it field support')) return 'ICT Network and Infrastructure'
  return 'ICT System and Support'
}

function isClosedStatusName(value: string | null | undefined): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!normalized) return false
  return ['resolved', 'closed', 'cancelled', 'canceled'].some((prefix) => {
    return normalized === prefix || normalized.startsWith(`${prefix} `) || normalized.startsWith(`${prefix}-`)
  })
}

export class InboundCommandService {
  private readonly allowedPhones: string[]
  private readonly lapsAdminPhones: string[]

  constructor(
    private readonly messaging: MessagingService,
    private readonly directory: DirectoryService,
    private readonly ldap: LdapService,
    allowedPhoneNumbers: string[]
  ) {
    this.allowedPhones = allowedPhoneNumbers.map(normalizePhoneDigits).filter(Boolean)
    const lapsAdmins = parseEnvPhoneList(process.env.LAPS_ADMIN_PHONE_NUMBERS)
    this.lapsAdminPhones = lapsAdmins.length > 0 ? lapsAdmins : this.allowedPhones

    console.log(
      '[command:init]',
      JSON.stringify({
        allowedPhoneCount: this.allowedPhones.length,
        lapsAdminCount: this.lapsAdminPhones.length,
        accessMode: this.allowedPhones.length > 0 ? 'restricted' : 'open',
        technicianStorage: getTechnicianContactsPath(),
      })
    )
  }

  private async resolveSenderPhoneDigits(senderId: string): Promise<string> {
    let senderDigits = normalizePhoneDigits(extractDigitsFromJid(senderId))

    if (senderId.endsWith('@lid')) {
      try {
        const resolvedPhone = await this.directory.resolvePhone(senderId)
        if (resolvedPhone) {
          senderDigits = normalizePhoneDigits(resolvedPhone)
        }
        console.log(
          '[command:access_lookup]',
          JSON.stringify({
            senderId,
            senderDigits,
            resolvedPhone: resolvedPhone ?? null,
            resolved: Boolean(resolvedPhone),
          })
        )
      } catch (error) {
        console.error(
          '[command:access_lookup_failed]',
          JSON.stringify({
            senderId,
            senderDigits,
            message: error instanceof Error ? error.message : String(error),
          })
        )
      }
    }

    return senderDigits
  }

  private async isAllowed(senderId: string): Promise<boolean> {
    if (this.allowedPhones.length < 1) return true
    const senderDigits = await this.resolveSenderPhoneDigits(senderId)
    return this.allowedPhones.includes(senderDigits)
  }

  private async isLapsAdmin(senderId: string): Promise<boolean> {
    if (this.lapsAdminPhones.length < 1) return false
    const senderDigits = await this.resolveSenderPhoneDigits(senderId)
    const allowed = this.lapsAdminPhones.includes(senderDigits)
    debugLapsAuth('is_admin', {
      requester: maskPhoneForLogs(senderDigits),
      result: allowed,
      adminsCount: this.lapsAdminPhones.length,
    })
    return allowed
  }

  private async canUseLaps(senderId: string): Promise<boolean> {
    const senderDigits = await this.resolveSenderPhoneDigits(senderId)
    if (!senderDigits) {
      debugLapsAuth('can_use_laps', { requesterRaw: senderId, normalized: null, result: false, reason: 'normalize_failed' })
      return false
    }

    if (await this.isLapsAdmin(senderId)) {
      debugLapsAuth('can_use_laps', { requester: maskPhoneForLogs(senderDigits), result: true, reason: 'admin' })
      return true
    }

    const contact = getContactByPhone(senderDigits)
    const hasAccess = contact?.laps_access === true
    debugLapsAuth('can_use_laps', {
      requester: maskPhoneForLogs(senderDigits),
      result: hasAccess,
      reason: hasAccess ? 'technician_flag' : 'no_flag',
      contactFound: Boolean(contact),
    })
    return hasAccess
  }

  private async canUseTechnicianDirectory(senderId: string): Promise<boolean> {
    if (await this.isAllowed(senderId)) return true
    return await this.isLapsAdmin(senderId)
  }

  private async reply(chatId: string, reply: CommandReply): Promise<void> {
    if (reply.kind === 'image') {
      await this.messaging.sendImage({
        chatId,
        caption: reply.caption,
        source: {
          kind: 'buffer',
          buffer: reply.buffer,
          mimetype: reply.mimetype,
          filename: reply.filename ?? 'finduser-photo.jpg',
        },
      })
      return
    }

    await this.messaging.sendText({ chatId, text: reply.text })
  }

  private async sendReactionText(chatId: string, text: string): Promise<void> {
    await this.messaging.sendText({ chatId, text })
  }

  private logReaction(event: ReactionAction, details: Record<string, DebugValue>): void {
    const orderedKeys = [
      'ticketId',
      'chatId',
      'messageId',
      'senderPhone',
      'senderId',
      'outcome',
      'ignoredReason',
      'notifyTarget',
      'notifyStatus',
      'requestedRestoreStatus',
      'requestedRestoreAssignedTo',
      'requestedRestoreIctTechnician',
      'verifyStatus',
      'verifyAssignedTo',
      'verifyIctTechnician',
      'detail',
    ]
    const suffix = formatDebugPairs(details, orderedKeys)
    console.log('[ticket-reaction]', `event=${event}${suffix ? ` | ${suffix}` : ''}`)
  }

  private async resolveReactionActorPhone(event: ReactionEvent): Promise<string | null> {
    if (event.senderPhone) {
      const normalized = normalizePhoneDigits(event.senderPhone)
      if (normalized) return normalized
    }

    const resolved = await this.resolveSenderPhoneDigits(event.senderId)
    return resolved || null
  }

  private async resolveRequesterNotificationChatId(request: Awaited<ReturnType<typeof viewRequest>>): Promise<string | null> {
    const direct = request?.requester?.mobile?.trim()
    if (direct) return phoneNumberFormatter(direct)

    const email = request?.requester?.email_id?.trim()
    if (!email) return null

    const ldapMobile = await findUserMobileByEmail({ email })
    return ldapMobile ? phoneNumberFormatter(ldapMobile) : null
  }

  private buildTechnicianClaimedMessage(args: {
    ticketId: string
    requesterLabel: string
    status: string
    priority: string
    category: string
    subject: string
    description: string
    link: string
  }): string {
    return (
      `*Ticket claimed by you*\n\n` +
      `Ticket ID: ${args.ticketId}\n` +
      `Requester: ${args.requesterLabel}\n` +
      `Status: ${args.status}\n` +
      `Priority: ${args.priority}\n` +
      `Category: ${args.category}\n` +
      `Subject: ${args.subject}\n` +
      `Description: ${args.description}\n` +
      `Link: ${args.link}`
    )
  }

  private buildRequesterAssignedMessage(args: {
    requesterLabel: string
    ticketId: string
    assigneeName: string
    link: string
  }): string {
    return (
      `Dear *${args.requesterLabel}*,\n\n` +
      `Your ticket has been assigned to *${args.assigneeName}*.\n\n` +
      `Ticket ID: ${args.ticketId}\n\n` +
      `Link: ${args.link}`
    )
  }

  private async notifyClaimParticipants(args: {
    ticketId: string
    tech: TechnicianContact
    request: Awaited<ReturnType<typeof viewRequest>>
  }): Promise<void> {
    const ticketLink = buildTicketLink(args.ticketId)
    const requesterLabel = getRequesterLabel(args.request ?? {})
    const subject = args.request?.subject?.trim() || 'No subject'
    const description = truncateText(stripHtmlToText(args.request?.description ?? '') || 'No description', 200)
    const category = args.request?.service_category?.name?.trim() || 'N/A'
    const priority = args.request?.priority?.name?.trim() || 'Low'
    const status = args.request?.status?.name?.trim() || 'In Progress'

    try {
      await this.messaging.sendText({
        chatId: phoneNumberFormatter(args.tech.phone),
        text: this.buildTechnicianClaimedMessage({
          ticketId: args.ticketId,
          requesterLabel,
          status,
          priority,
          category,
          subject,
          description,
          link: ticketLink,
        }),
      })
      this.logReaction('claim', {
        ticketId: args.ticketId,
        notifyTarget: 'technician',
        notifyStatus: 'sent',
      })
    } catch (error) {
      this.logReaction('claim', {
        ticketId: args.ticketId,
        notifyTarget: 'technician',
        notifyStatus: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    }

    const requesterChatId = await this.resolveRequesterNotificationChatId(args.request)
    if (!requesterChatId) {
      this.logReaction('claim', {
        ticketId: args.ticketId,
        notifyTarget: 'requester',
        notifyStatus: 'skipped',
        detail: 'requester_phone_unresolved',
      })
      return
    }

    try {
      await this.messaging.sendText({
        chatId: requesterChatId,
        text: this.buildRequesterAssignedMessage({
          requesterLabel,
          ticketId: args.ticketId,
          assigneeName: args.tech.name,
          link: ticketLink,
        }),
      })
      this.logReaction('claim', {
        ticketId: args.ticketId,
        notifyTarget: 'requester',
        notifyStatus: 'sent',
      })
    } catch (error) {
      this.logReaction('claim', {
        ticketId: args.ticketId,
        notifyTarget: 'requester',
        notifyStatus: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async handleReactionClaim(event: ReactionEvent): Promise<{ handled: boolean; commandName?: string }> {
    const reacterPhone = await this.resolveReactionActorPhone(event)
    if (!reacterPhone) {
      this.logReaction('claim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderId: event.senderId,
        ignoredReason: 'unresolved_phone',
      })
      return { handled: false }
    }

    const tech = getContactByPhone(reacterPhone)
    const stored = await loadTicketNotification({ remoteJid: event.chatId, messageId: event.messageId })
    if (!stored) {
      this.logReaction('claim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderId: event.senderId,
        senderPhone: reacterPhone,
        ignoredReason: 'notification_not_found',
      })
      return { handled: false }
    }

    const ticketId = stored.ticketId
    if (!tech) {
      await this.sendReactionText(
        event.chatId,
        `*Ticket Claim Failed*\nTicket ID: ${ticketId}\nReason: Phone ${reacterPhone} is not registered as a technician.`
      )
      this.logReaction('claim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderPhone: reacterPhone,
        ticketId,
        handled: true,
        outcome: 'not_a_technician',
      })
      return { handled: true, commandName: 'ticket_claim' }
    }

    if (stored.claimed) {
      const by = stored.claimedByName ?? stored.claimedByPhone ?? 'another technician'
      await this.sendReactionText(event.chatId, `*Ticket Already Claimed*\nTicket ID: *${ticketId}*\nClaimed by: *${by}*`)
      this.logReaction('claim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderPhone: reacterPhone,
        ticketId,
        handled: true,
        outcome: 'already_claimed_precheck',
      })
      return { handled: true, commandName: 'ticket_claim' }
    }

    const request = await viewRequest(ticketId)
    const previousStatus = request?.status?.name ?? null
    if (isClosedStatusName(previousStatus)) {
      await this.sendReactionText(
        event.chatId,
        `*Ticket Already Closed*\nTicket ID: *${ticketId}*\nStatus: *${previousStatus}*\nAction: Claim ignored.`
      )
      this.logReaction('claim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderPhone: reacterPhone,
        ticketId,
        handled: true,
        outcome: 'already_closed',
      })
      return { handled: true, commandName: 'ticket_claim' }
    }

    const claim = await claimTicketNotification({
      remoteJid: event.chatId,
      messageId: event.messageId,
      claimantPhone: reacterPhone,
      claimantName: tech.name,
      previous: {
        status: previousStatus,
        ictTechnician: request?.udf_fields?.udf_pick_601 ?? null,
        technicianName: request?.technician?.name ?? null,
        groupName: request?.group?.name ?? null,
      },
    })

    if (!claim.ok) {
      const reason =
        claim.reason === 'not_found'
          ? 'Ticket notification was not found.'
          : claim.reason === 'invalid_record'
            ? 'Ticket notification record is invalid.'
            : claim.detail ?? 'Ticket notification storage error.'
      await this.sendReactionText(event.chatId, `*Ticket Claim Failed*\nTicket ID: ${ticketId}\nReason: ${reason}`)
      this.logReaction('claim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderPhone: reacterPhone,
        ticketId,
        handled: true,
        outcome: 'claim_store_error',
        detail: reason,
      })
      return { handled: true, commandName: 'ticket_claim' }
    }

    if (claim.wasClaimed) {
      const by = claim.record.claimedByName ?? claim.record.claimedByPhone ?? 'another technician'
      await this.sendReactionText(event.chatId, `*Ticket Already Claimed*\nTicket ID: *${ticketId}*\nClaimed by: *${by}*`)
      this.logReaction('claim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderPhone: reacterPhone,
        ticketId,
        handled: true,
        outcome: 'already_claimed_race',
      })
      return { handled: true, commandName: 'ticket_claim' }
    }

    const priorityName = request?.priority?.name
    const priority = typeof priorityName === 'string' && priorityName.trim().length > 0 ? priorityName : 'Low'
    const updateResult = await updateRequest(ticketId, {
      ictTechnician: tech.ict_name,
      groupName: determineServiceDeskGroupByRole(tech.technician),
      technicianName: tech.technician,
      status: 'In Progress',
      priority,
    })

    if (!updateResult.success) {
      await this.sendReactionText(
        event.chatId,
        `*Ticket Claimed (Partial)*\nTicket ID: *${ticketId}*\nTechnician: *${tech.name}*\nUpdate: Failed\nDetails: ${updateResult.message}`
      )
      this.logReaction('claim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderPhone: reacterPhone,
        ticketId,
        handled: true,
        outcome: 'servicedesk_update_failed',
      })
      return { handled: true, commandName: 'ticket_claim' }
    }

    await this.notifyClaimParticipants({ ticketId, tech, request })
    await this.sendReactionText(event.chatId, `✅ Ticket *${ticketId}* claimed.\nTechnician: *${tech.name}*\nStatus: *In Progress*`)
    this.logReaction('claim', {
      chatId: event.chatId,
      messageId: event.messageId,
      senderPhone: reacterPhone,
      ticketId,
      handled: true,
      outcome: 'claimed',
    })
    return { handled: true, commandName: 'ticket_claim' }
  }

  private async handleReactionUnclaim(event: ReactionEvent): Promise<{ handled: boolean; commandName?: string }> {
    const reacterPhone = await this.resolveReactionActorPhone(event)
    if (!reacterPhone) {
      this.logReaction('unclaim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderId: event.senderId,
        ignoredReason: 'unresolved_phone',
      })
      return { handled: false }
    }

    const stored = await loadTicketNotification({ remoteJid: event.chatId, messageId: event.messageId })
    if (!stored) {
      this.logReaction('unclaim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderPhone: reacterPhone,
        ignoredReason: 'notification_not_found',
      })
      return { handled: false }
    }

    if (!stored.claimed) {
      this.logReaction('unclaim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderPhone: reacterPhone,
        ticketId: stored.ticketId,
        ignoredReason: 'not_claimed',
      })
      return { handled: false }
    }

    if (stored.claimedByPhone && stored.claimedByPhone !== reacterPhone) {
      this.logReaction('unclaim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderPhone: reacterPhone,
        ticketId: stored.ticketId,
        ignoredReason: 'not_claimer',
      })
      return { handled: false }
    }

    const result = await unclaimTicketNotification({
      remoteJid: event.chatId,
      messageId: event.messageId,
      claimantPhone: reacterPhone,
    })
    if (!result.ok || !result.wasUnclaimed) {
      this.logReaction('unclaim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderPhone: reacterPhone,
        ticketId: stored.ticketId,
        ignoredReason: result.ok ? 'not_unclaimed' : result.reason,
      })
      return { handled: false }
    }

    const request = await viewRequest(stored.ticketId)
    const priorityName = request?.priority?.name
    const priority = typeof priorityName === 'string' && priorityName.trim().length > 0 ? priorityName : 'Low'
    const statusToRestore =
      typeof stored.previousStatus === 'string' && stored.previousStatus.trim().length > 0 ? stored.previousStatus : 'Open'

    const updateResult = await updateRequest(stored.ticketId, {
      status: statusToRestore,
      priority,
      technicianName: null,
      groupName: stored.previousGroupName !== undefined ? stored.previousGroupName : undefined,
      ictTechnician: null,
    })

    if (!updateResult.success) {
      await this.sendReactionText(
        event.chatId,
        `*Ticket Unclaimed (Partial)*\nTicket ID: *${stored.ticketId}*\nRemoved by: *${stored.claimedByName ?? stored.claimedByPhone ?? reacterPhone}*\nRevert: Failed\nDetails: ${updateResult.message}`
      )
      this.logReaction('unclaim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderPhone: reacterPhone,
        ticketId: stored.ticketId,
        handled: true,
        outcome: 'servicedesk_revert_failed',
      })
      return { handled: true, commandName: 'ticket_unclaim' }
    }

    try {
      const refreshed = await viewRequest(stored.ticketId)
      this.logReaction('unclaim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderPhone: reacterPhone,
        ticketId: stored.ticketId,
        requestedRestoreStatus: statusToRestore,
        requestedRestoreAssignedTo: null,
        requestedRestoreIctTechnician: null,
        detail: formatDebugPairs({
          previousAssignedTo: stored.previousTechnicianName !== undefined ? stored.previousTechnicianName : null,
          previousIctTechnician: stored.previousIctTechnician !== undefined ? stored.previousIctTechnician : null,
        }),
        verifyStatus: refreshed?.status?.name ?? null,
        verifyAssignedTo: refreshed?.technician?.name ?? null,
        verifyIctTechnician: refreshed?.udf_fields?.udf_pick_601 ?? null,
      })
    } catch (error) {
      this.logReaction('unclaim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderPhone: reacterPhone,
        ticketId: stored.ticketId,
        verifyAfterUpdate: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    }

    const assignmentLabel =
      (typeof stored.previousTechnicianName === 'string' && stored.previousTechnicianName.trim().length > 0) ||
      (typeof stored.previousGroupName === 'string' && stored.previousGroupName.trim().length > 0)
        ? 'Restored'
        : 'Cleared'

    await this.sendReactionText(
      event.chatId,
      `*Ticket Unclaimed*\nTicket ID: *${stored.ticketId}*\nRemoved by: *${stored.claimedByName ?? stored.claimedByPhone ?? reacterPhone}*\nStatus: *${statusToRestore}*\nAssignment: ${assignmentLabel}`
    )
    this.logReaction('unclaim', {
      chatId: event.chatId,
      messageId: event.messageId,
      senderPhone: reacterPhone,
      ticketId: stored.ticketId,
      handled: true,
      outcome: 'unclaimed',
    })
    return { handled: true, commandName: 'ticket_unclaim' }
  }

  private handleTechnicianCommand(tokens: string[], isGroup: boolean): CommandHandleResult {
    void isGroup
    const subRaw = tokens[1]?.toLowerCase()
    const sub = subRaw ? subRaw.replace(/^\/+/, '') : undefined

    if (!sub) {
      return {
        handled: true,
        commandName: 'technician',
        replies: [textReply('Usage: /technician <list|search|view|add|update|delete|mapleave>')],
      }
    }

    if (sub === 'list') {
      const contacts = listTechnicianContacts()
      if (contacts.length < 1) {
        return {
          handled: true,
          commandName: 'technician',
          replies: [
            textReply(
              `No technicians found.\n\nStorage: ${getTechnicianContactsPath()}\n\n` +
                'Add one:\n' +
                '/technician add "Name" "ICT Name" "628xxxxxxxxxxx" "email@company.com" "Role" "Gender"'
            ),
          ],
        }
      }

      return {
        handled: true,
        commandName: 'technician',
        replies: [textReply(`*Technicians* (${contacts.length})\n\n${renderTechnicianTable(contacts)}`)],
      }
    }

    if (sub === 'search') {
      const query = tokens.slice(2).join(' ').trim()
      if (!query) {
        return { handled: true, commandName: 'technician', replies: [textReply('Usage: /technician search <query>')] }
      }

      const results = searchTechnicianContacts(query)
      if (results.length < 1) {
        return { handled: true, commandName: 'technician', replies: [textReply('No technicians matched your query.')] }
      }

      return {
        handled: true,
        commandName: 'technician',
        replies: [textReply(`*Technician Search Results*\nQuery: ${query}\nMatches: ${results.length}\n\n${renderTechnicianTable(results)}`)],
      }
    }

    if (sub === 'view') {
      const id = Number(tokens[2])
      if (!Number.isFinite(id)) {
        return { handled: true, commandName: 'technician', replies: [textReply('Usage: /technician view <id>')] }
      }

      const contact = getTechnicianContactById(id)
      if (!contact) {
        return { handled: true, commandName: 'technician', replies: [textReply(`Technician with id ${id} not found.`)] }
      }

      return {
        handled: true,
        commandName: 'technician',
        replies: [textReply(`*Technician Details*\n\n${renderTechnicianDetails(contact)}`)],
      }
    }

    if (sub === 'add') {
      const name = tokens[2]
      const ictName = tokens[3]
      const phone = tokens[4]
      const emailRaw = tokens[5]
      const technician = tokens[6]
      const gender = tokens[7]

      if (!name || !ictName || !phone || !emailRaw || !technician) {
        return {
          handled: true,
          commandName: 'technician',
          replies: [textReply('Usage: /technician add "Name" "ICT Name" "Phone" "Email" "Role" "Gender"')],
        }
      }

      const created = addTechnicianContact({
        name,
        ict_name: ictName,
        phone,
        email: emailRaw.toLowerCase() === 'null' || emailRaw === '-' ? null : emailRaw,
        technician,
        gender: gender ?? null,
        leave_schedule_name: null,
        laps_access: false,
      })

      return {
        handled: true,
        commandName: 'technician',
        replies: [textReply(`Technician added.\n\n${renderTechnicianDetails(created)}`)],
      }
    }

    if (sub === 'update') {
      const id = Number(tokens[2])
      const fieldRaw = tokens[3]
      const value = tokens.slice(4).join(' ').trim()

      if (!Number.isFinite(id) || !fieldRaw || !value || !isUpdateField(fieldRaw)) {
        return {
          handled: true,
          commandName: 'technician',
          replies: [
            textReply(
              'Usage: /technician update <id> "field" "value" (fields: name, ict_name, leave_schedule_name, phone, email, technician, gender, laps_access)'
            ),
          ],
        }
      }

      const updated = updateTechnicianContact(id, fieldRaw, value)
      if (!updated) {
        return { handled: true, commandName: 'technician', replies: [textReply(`Update failed for technician id ${id}.`)] }
      }

      return {
        handled: true,
        commandName: 'technician',
        replies: [textReply(`Technician updated.\n\n${renderTechnicianDetails(updated)}`)],
      }
    }

    if (sub === 'delete') {
      const id = Number(tokens[2])
      if (!Number.isFinite(id)) {
        return { handled: true, commandName: 'technician', replies: [textReply('Usage: /technician delete <id>')] }
      }

      return {
        handled: true,
        commandName: 'technician',
        replies: [textReply(deleteTechnicianContact(id) ? `Technician id ${id} deleted.` : `Technician id ${id} not found.`)],
      }
    }

    if (sub === 'mapleave') {
      try {
        const result = determineLeaveScheduleMapping()
        const byMode = result.changed.reduce(
          (accumulator, item) => {
            accumulator[item.mode] += 1
            return accumulator
          },
          { exact: 0, pattern: 0, fuzzy: 0 }
        )

        const lines: string[] = [
          '*Leave mapping update completed*',
          `Date: ${result.dateIso}`,
          `Sheet: ${result.sheetName}`,
          `File: ${result.xlsxPath}`,
          `Updated: ${result.changed.length}`,
          `Skipped existing mapping: ${result.skippedExisting}`,
          `Unresolved: ${result.unresolved.length}`,
          `Modes: exact=${byMode.exact}, pattern=${byMode.pattern}, fuzzy=${byMode.fuzzy}`,
        ]

        if (result.changed.length > 0) {
          lines.push('', '*Updated mappings:*')
          for (const row of result.changed.slice(0, 20)) {
            lines.push(`- [${row.id}] ${row.ictName} => ${row.value} (${row.mode})`)
          }
          if (result.changed.length > 20) {
            lines.push(`- ...and ${result.changed.length - 20} more`)
          }
        }

        if (result.unresolved.length > 0) {
          lines.push('', '*Unresolved:*')
          for (const row of result.unresolved.slice(0, 20)) {
            lines.push(`- [${row.id}] ${row.ictName}`)
          }
          if (result.unresolved.length > 20) {
            lines.push(`- ...and ${result.unresolved.length - 20} more`)
          }
        }

        return {
          handled: true,
          commandName: 'technician',
          replies: [textReply(lines.join('\n'))],
        }
      } catch (error) {
        return {
          handled: true,
          commandName: 'technician',
          replies: [textReply(`Map leave failed: ${error instanceof Error ? error.message : String(error)}`)],
        }
      }
    }

    return {
      handled: true,
      commandName: 'technician',
      replies: [textReply('Unknown technician command. Use /technician list, search, view, add, update, delete, or mapleave.')],
    }
  }

  private async handleCommandText(text: string, senderId: string, isGroup: boolean): Promise<CommandHandleResult> {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) return { handled: false }

    const tokens = splitCommandLine(trimmed)
    const command = tokens[0]?.toLowerCase() ?? ''

    switch (command) {
      case '/hi':
        return { handled: true, commandName: 'hi', replies: [textReply('Hello! The inbound command path is live.')] }

      case '/ping':
        return {
          handled: true,
          commandName: 'ping',
          replies: [textReply('pong - webhook -> parser -> command -> reply is working.')],
        }

      case '/help':
        {
          const targetRaw = tokens[1]?.replace(/^\/+/, '').toLowerCase()
          if (!targetRaw) {
            return { handled: true, commandName: 'help', replies: [textReply(HELP_TEXT)] }
          }

          const help = renderCommandHelp(targetRaw)
          if (!help) {
            const supported = Object.keys(COMMAND_HELP)
              .sort()
              .map((key) => `- ${key}`)
              .join('\n')
            return {
              handled: true,
              commandName: 'help',
              replies: [
                textReply(
                  `Unknown command "${targetRaw}".\n\nUse /help to see the command list.\n\n*Supported /help keys:*\n${supported}`
                ),
              ],
            }
          }

          return { handled: true, commandName: 'help', replies: [textReply(help)] }
        }

      case '/finduser': {
        const args = tokens.slice(1)
        const photoIdx = args.findIndex((part) => part.toLowerCase() === '/photo')
        const includePhoto = photoIdx !== -1
        if (includePhoto) args.splice(photoIdx, 1)

        if (args.length < 1) {
          return {
            handled: true,
            commandName: 'finduser',
            replies: [textReply('Error: No name provided with /finduser command')],
          }
        }

        const query = args.join(' ')
        const result = await this.ldap.findUsersByCommonName({ query, includePhoto })
        if (!result.success) {
          return {
            handled: true,
            commandName: 'finduser',
            replies: [textReply(`Error finding user: ${result.error}`)],
          }
        }

        if (result.users.length < 1) {
          return {
            handled: true,
            commandName: 'finduser',
            replies: [textReply('User not found.')],
          }
        }

        return {
          handled: true,
          commandName: 'finduser',
          replies: result.users.map((user) => {
            const rendered = renderFindUserCaption({ user, includePhoto })
            if (includePhoto && rendered.hasPhoto && rendered.photoBuffer) {
              return {
                kind: 'image',
                caption: rendered.caption,
                buffer: rendered.photoBuffer,
                mimetype: rendered.photoContentType,
                filename: 'finduser-photo.jpg',
              } satisfies CommandReply
            }
            return textReply(rendered.caption)
          }),
        }
      }

      case '/resetpassword': {
        if (!(await this.isAllowed(senderId))) {
          return { handled: true, commandName: 'resetpassword', replies: [textReply('Access denied.')] }
        }

        const username = tokens[1]
        const newPassword = tokens[2]
        const changeFlag = tokens[3] === '/change'

        if (!username || !newPassword) {
          return {
            handled: true,
            commandName: 'resetpassword',
            replies: [textReply('Usage: /resetpassword <username> <newPassword> [/change]')],
          }
        }

        const result = await this.ldap.resetPassword({
          username,
          newPassword,
          changePasswordAtNextLogon: changeFlag,
        })
        if (!result.success) {
          return {
            handled: true,
            commandName: 'resetpassword',
            replies: [textReply(`Error resetting password for ${username}: ${result.error}`)],
          }
        }

        return {
          handled: true,
          commandName: 'resetpassword',
          replies: [textReply(`Password reset for ${username} successful`)],
        }
      }

      case '/unlock': {
        if (!(await this.canUseLaps(senderId))) {
          return { handled: true, commandName: 'unlock', replies: [textReply('Access denied.')] }
        }

        const username = tokens[1]
        if (!username) {
          return {
            handled: true,
            commandName: 'unlock',
            replies: [textReply('Usage: /unlock <username>')],
          }
        }

        const result = await this.ldap.unlockAccount({ username })
        if (!result.success) {
          return {
            handled: true,
            commandName: 'unlock',
            replies: [textReply(`Error unlocking account for ${username}: ${result.error}`)],
          }
        }

        return {
          handled: true,
          commandName: 'unlock',
          replies: [textReply(`Account unlocked for ${username} successful`)],
        }
      }

      case '/getbitlocker': {
        const hostname = tokens[1]
        if (!hostname) {
          return {
            handled: true,
            commandName: 'getbitlocker',
            replies: [textReply('Usage: /getbitlocker <hostname>')],
          }
        }

        const result = await this.ldap.getBitLockerInfo({ hostname })
        if (!result.success) {
          return {
            handled: true,
            commandName: 'getbitlocker',
            replies: [textReply(`*Error:* ${result.error}`)],
          }
        }

        const lines: string[] = [
          '*BitLocker Recovery Keys*',
          `*Hostname:* ${result.data.hostname.toUpperCase()}`,
          `*Found:* ${result.data.keys.length}`,
          '',
        ]

        result.data.keys.forEach((key, index) => {
          const passwordId = (key.partitionId.split('{')[1] || '').replace('}', '').trim() || 'Unknown'
          lines.push(`*Key ${index + 1}*`)
          lines.push(`• *Password ID:* ${passwordId}`)
          lines.push(`• *Created:* ${formatBitLockerDate(key.partitionId)}`)
          lines.push(`• *Recovery Key:* ${key.password}`)
          if (index < result.data.keys.length - 1) lines.push('')
        })

        return {
          handled: true,
          commandName: 'getbitlocker',
          replies: [textReply(lines.join('\n'))],
        }
      }

      case '/getasset': {
        try {
          const reply = await buildGetAssetReply(trimmed)
          return {
            handled: true,
            commandName: 'getasset',
            replies: [textReply(reply)],
          }
        } catch (error) {
          return {
            handled: true,
            commandName: 'getasset',
            replies: [textReply(`Error getting assets: ${error instanceof Error ? error.message : String(error)}`)],
          }
        }
      }

      case '/licenses': {
        const limitRaw = tokens[1]
        const offsetRaw = tokens[2]
        const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.max(1, Number(limitRaw)) : 20
        const offset = offsetRaw && /^\d+$/.test(offsetRaw) ? Math.max(0, Number(offsetRaw)) : 0

        if ((limitRaw && !/^\d+$/.test(limitRaw)) || (offsetRaw && !/^\d+$/.test(offsetRaw))) {
          return {
            handled: true,
            commandName: 'licenses',
            replies: [textReply('Usage: /licenses [limit] [offset]\nExample: /licenses 20 0')],
          }
        }

        const result = await getLicenses({ limit, offset })
        if (!result.success) {
          return {
            handled: true,
            commandName: 'licenses',
            replies: [textReply(`Error fetching licenses: ${result.error}`)],
          }
        }

        if (result.licenses.length < 1) {
          return {
            handled: true,
            commandName: 'licenses',
            replies: [textReply('No licenses found in Snipe-IT.')],
          }
        }

        const lines: string[] = [`*Licenses* (${result.total} total, showing ${result.licenses.length})`, '']
        result.licenses.forEach((license, index) => {
          const name = license.name ?? 'Unnamed License'
          const category = license.categoryName ?? 'Uncategorized'
          const seats = Math.max(0, license.seats)
          const available = Math.max(0, license.freeSeats)
          const used = Math.max(0, seats - available)
          const expiration = license.expirationDateFormatted ?? 'No expiration'

          lines.push(`*${index + 1}. ${name}*`)
          lines.push(`• Category: ${category}`)
          lines.push(`• Seats: ${used}/${seats} used (${available} available)`)
          lines.push(`• Expires: ${expiration}`)
          lines.push('')
        })
        lines.push('_Use /getlicense <name_or_id> for detailed information._')

        return {
          handled: true,
          commandName: 'licenses',
          replies: [textReply(lines.join('\n'))],
        }
      }

      case '/getlicense': {
        const identifier = tokens.slice(1).join(' ').trim()
        if (!identifier) {
          return {
            handled: true,
            commandName: 'getlicense',
            replies: [textReply('Usage: /getlicense <license_name_or_id>\nExample: /getlicense "Microsoft Office"')],
          }
        }

        const result = await getLicenseByName(identifier)
        if (!result.success) {
          const lines: string[] = [result.error]
          if (result.suggestions && result.suggestions.length > 0) {
            lines.push('', '*Suggestions:*', ...result.suggestions.map((name) => `• ${name}`))
          }

          return {
            handled: true,
            commandName: 'getlicense',
            replies: [textReply(lines.join('\n'))],
          }
        }

        const license = result.license
        const name = license.name ?? 'Unnamed License'
        const category = license.categoryName ?? 'Uncategorized'
        const manufacturer = license.manufacturerName ?? 'Unknown'
        const seats = Math.max(0, license.seats)
        const available = Math.max(0, license.freeSeats)
        const used = Math.max(0, seats - available)
        const expiration = license.expirationDateFormatted ?? 'No expiration'
        const purchaseDate = license.purchaseDateFormatted ?? 'Unknown'
        const purchaseCost = license.purchaseCost ?? 'Unknown'
        const notes = license.notes ?? 'No notes'

        return {
          handled: true,
          commandName: 'getlicense',
          replies: [
            textReply(
              [
                '*License Details*',
                '',
                `*Name:* ${name}`,
                `*ID:* ${license.id}`,
                `*Category:* ${category}`,
                `*Manufacturer:* ${manufacturer}`,
                `*Seats:* ${used}/${seats} used (${available} available)`,
                `*Expiration:* ${expiration}`,
                `*Purchase Date:* ${purchaseDate}`,
                `*Purchase Cost:* ${purchaseCost}`,
                `*Notes:* ${notes}`,
              ].join('\n')
            ),
          ],
        }
      }

      case '/expiring': {
        const daysRaw = tokens[1]
        if (daysRaw && !/^\d+$/.test(daysRaw)) {
          return {
            handled: true,
            commandName: 'expiring',
            replies: [textReply('Usage: /expiring [days]\nExample: /expiring 30')],
          }
        }

        const days = daysRaw ? Math.max(1, Number(daysRaw)) : 30
        const result = await getExpiringLicenses(days)
        if (!result.success) {
          return {
            handled: true,
            commandName: 'expiring',
            replies: [textReply(`Error fetching expiring licenses: ${result.error}`)],
          }
        }

        if (result.licenses.length < 1) {
          return {
            handled: true,
            commandName: 'expiring',
            replies: [textReply(`No licenses expiring within ${days} days.`)],
          }
        }

        const lines: string[] = [`*Licenses Expiring in ${days} Days* (${result.total} found)`, '']
        result.licenses.forEach((license, index) => {
          const name = license.name ?? 'Unnamed License'
          const category = license.categoryName ?? 'Uncategorized'
          const expiration = license.expirationDateFormatted ?? 'Unknown'
          const seats = Math.max(0, license.seats)
          const available = Math.max(0, license.freeSeats)
          const used = Math.max(0, seats - available)

          let daysUntilExpiration = 'unknown'
          if (license.expirationDateIso) {
            const expirationDate = new Date(license.expirationDateIso)
            if (!Number.isNaN(expirationDate.getTime())) {
              daysUntilExpiration = String(Math.ceil((expirationDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
            }
          }

          lines.push(`*${index + 1}. ${name}*`)
          lines.push(`• Category: ${category}`)
          lines.push(`• Usage: ${used}/${seats} seats`)
          lines.push(`• Expires: ${expiration} (${daysUntilExpiration} days)`)
          lines.push('')
        })

        return {
          handled: true,
          commandName: 'expiring',
          replies: [textReply(lines.join('\n'))],
        }
      }

      case '/licensereport': {
        const result = await getLicenseUtilization()
        if (!result.success) {
          return {
            handled: true,
            commandName: 'licensereport',
            replies: [textReply(`Error generating license report: ${result.error}`)],
          }
        }

        const data = result.data
        const lines: string[] = [
          '*License Utilization Report*',
          '',
          '*Overview:*',
          `• Total Licenses: ${data.totalLicenses}`,
          '',
          '*Utilization:*',
          `• Fully Utilized (100%): ${data.utilization.fullyUtilized}`,
          `• Partially Utilized (50-99%): ${data.utilization.partiallyUtilized}`,
          `• Under Utilized (1-49%): ${data.utilization.underUtilized}`,
          `• Not Utilized (0%): ${data.utilization.notUtilized}`,
          '',
          '*Expiration Status:*',
          `• Expired: ${data.expiration.expired}`,
          `• Expiring Soon (30 days): ${data.expiration.expiringSoon}`,
          `• Valid: ${data.expiration.valid}`,
          `• No Expiration: ${data.expiration.noExpiration}`,
        ]

        const categoryEntries = Object.entries(data.categories).sort((a, b) => a[0].localeCompare(b[0]))
        if (categoryEntries.length > 0) {
          lines.push('', '*Categories:*')
          for (const [categoryName, category] of categoryEntries) {
            lines.push(`• ${categoryName}: ${category.count} licenses, ${category.usedSeats}/${category.totalSeats} seats used`)
          }
        }

        return {
          handled: true,
          commandName: 'licensereport',
          replies: [textReply(lines.join('\n'))],
        }
      }

      case '/getlaps': {
        if (isGroup) {
          return { handled: true, commandName: 'getlaps', replies: [textReply('Use /getlaps in a private chat only.')] }
        }

        if (this.lapsAdminPhones.length < 1) {
          return {
            handled: true,
            commandName: 'getlaps',
            replies: [textReply('Access denied. Configure LAPS_ADMIN_PHONE_NUMBERS (or ALLOWED_PHONE_NUMBERS) before using /getlaps.')],
          }
        }

        if (!(await this.canUseLaps(senderId))) {
          return { handled: true, commandName: 'getlaps', replies: [textReply('Access denied.')] }
        }

        const hostname = tokens[1]
        if (!hostname) {
          return {
            handled: true,
            commandName: 'getlaps',
            replies: [textReply('Usage: /getlaps <hostname>')],
          }
        }

        const result = await this.ldap.getLapsInfo({ hostname })
        if (!result.success) {
          return {
            handled: true,
            commandName: 'getlaps',
            replies: [textReply(`Error: ${result.error}`)],
          }
        }

        const data = result.data
        return {
          handled: true,
          commandName: 'getlaps',
          replies: [
            textReply(
              [
                '*LAPS Credentials*',
                `*Hostname:* ${data.hostname.toUpperCase()}`,
                `*Account:* ${data.account ?? 'Administrator'}`,
                `*Password:* ${data.password}`,
                `*Source:* ${data.source}`,
                `*Expires:* ${data.expiration ?? 'Unknown'}`,
              ].join('\n')
            ),
          ],
        }
      }

      case '/getlapsdiag': {
        if (isGroup) {
          return { handled: true, commandName: 'getlapsdiag', replies: [textReply('Use /getlapsdiag in a private chat only.')] }
        }

        if (this.lapsAdminPhones.length < 1) {
          return {
            handled: true,
            commandName: 'getlapsdiag',
            replies: [
              textReply('Access denied. Configure LAPS_ADMIN_PHONE_NUMBERS (or ALLOWED_PHONE_NUMBERS) before using /getlapsdiag.'),
            ],
          }
        }

        if (!(await this.canUseLaps(senderId))) {
          return { handled: true, commandName: 'getlapsdiag', replies: [textReply('Access denied.')] }
        }

        const hostname = tokens[1]
        if (!hostname) {
          return {
            handled: true,
            commandName: 'getlapsdiag',
            replies: [textReply('Usage: /getlapsdiag <hostname>')],
          }
        }

        const result = await this.ldap.getLapsDiagnostics({ hostname })
        if (!result.success) {
          return {
            handled: true,
            commandName: 'getlapsdiag',
            replies: [textReply(`Error: ${result.error}`)],
          }
        }

        const data = result.data
        return {
          handled: true,
          commandName: 'getlapsdiag',
          replies: [
            textReply(
              [
                '*LAPS LDAP Diagnostics*',
                `*Hostname:* ${data.hostname.toUpperCase()}`,
                `*DN:* ${data.distinguishedName}`,
                '',
                '*Visible Attributes:*',
                `• msLAPS-Password: ${data.visibleAttributes.msLapsPassword ? 'yes' : 'no'}`,
                `• msLAPS-EncryptedPassword: ${data.visibleAttributes.msLapsEncryptedPassword ? 'yes' : 'no'}`,
                `• msLAPS-PasswordExpirationTime: ${data.visibleAttributes.msLapsPasswordExpirationTime ? 'yes' : 'no'}`,
                `• ms-Mcs-AdmPwd: ${data.visibleAttributes.msMcsAdmPwd ? 'yes' : 'no'}`,
                `• ms-Mcs-AdmPwdExpirationTime: ${data.visibleAttributes.msMcsAdmPwdExpirationTime ? 'yes' : 'no'}`,
              ].join('\n')
            ),
          ],
        }
      }

      case '/setlaps': {
        if (isGroup) {
          return { handled: true, commandName: 'setlaps', replies: [textReply('Use /setlaps in a private chat only.')] }
        }

        if (this.lapsAdminPhones.length < 1) {
          return {
            handled: true,
            commandName: 'setlaps',
            replies: [textReply('Access denied. Configure LAPS_ADMIN_PHONE_NUMBERS (or ALLOWED_PHONE_NUMBERS) before using /setlaps.')],
          }
        }

        if (!(await this.isLapsAdmin(senderId))) {
          return { handled: true, commandName: 'setlaps', replies: [textReply('Access denied.')] }
        }

        const kind = tokens[1]?.toLowerCase()
        const idRaw = tokens[2]
        const actionRaw = tokens[3]
        if (kind !== 'technician' || !idRaw || !actionRaw) {
          return {
            handled: true,
            commandName: 'setlaps',
            replies: [textReply('Usage: /setlaps technician <id> /a|/d\nExample: /setlaps technician 7 /a')],
          }
        }

        const id = Number(idRaw)
        if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
          return {
            handled: true,
            commandName: 'setlaps',
            replies: [textReply('Invalid technician id. Use: /setlaps technician <id> /a|/d')],
          }
        }

        const action = actionRaw.replace(/^\/+/, '').trim().toLowerCase()
        const allow = action === 'a' || action === 'add'
        const deny = action === 'd' || action === 'del' || action === 'delete'
        if (!allow && !deny) {
          return {
            handled: true,
            commandName: 'setlaps',
            replies: [textReply('Invalid action. Use /a (allow) or /d (deny).')],
          }
        }

        const updated = updateTechnicianContact(id, 'laps_access', allow ? 'true' : 'false')
        if (!updated) {
          return {
            handled: true,
            commandName: 'setlaps',
            replies: [textReply(`Update failed for technician id ${id}.`)],
          }
        }

        return {
          handled: true,
          commandName: 'setlaps',
          replies: [textReply(`LAPS access ${allow ? 'granted' : 'revoked'}.\n\n${renderTechnicianDetails(updated)}`)],
        }
      }

      case '/technician': {
        if (!(await this.canUseTechnicianDirectory(senderId))) {
          return { handled: true, commandName: 'technician', replies: [textReply('Access denied.')] }
        }

        const sub = tokens[1]?.replace(/^\/+/, '').toLowerCase()
        const needsAdmin = sub === 'add' || sub === 'update' || sub === 'delete' || sub === 'mapleave'
        if (needsAdmin && !(await this.isLapsAdmin(senderId))) {
          return { handled: true, commandName: 'technician', replies: [textReply('Access denied.')] }
        }

        return this.handleTechnicianCommand(tokens, isGroup)
      }

      default:
        return {
          handled: true,
          commandName: command.replace(/^\//, ''),
          replies: [textReply(`Command ${command} has not been ported to the root app yet. Send /help for active commands.`)],
        }
    }
  }

  async processInboundMessage(event: InboundMessageEvent): Promise<{ handled: boolean; commandName?: string }> {
    console.log(
      '[command:incoming]',
      JSON.stringify({
        eventType: event.eventType,
        sessionId: event.sessionId,
        chatId: event.chatId,
        senderId: event.senderId,
        isGroup: event.isGroup,
        messageId: event.messageId,
        textPreview: truncate(event.text),
      })
    )

    const result = await this.handleCommandText(event.text, event.senderId, event.isGroup)
    if (!result.handled || !result.replies || result.replies.length < 1) {
      console.log(
        '[command:ignored]',
        JSON.stringify({
          reason: 'not_a_supported_command',
          textPreview: truncate(event.text),
        })
      )
      return { handled: false }
    }

    console.log(
      '[command:matched]',
      JSON.stringify({
        commandName: result.commandName ?? null,
        willReply: true,
        replyCount: result.replies.length,
        replyPreview: truncate(
          result.replies[0]?.kind === 'text' ? result.replies[0].text : result.replies[0]?.caption ?? ''
        ),
      })
    )

    try {
      for (const reply of result.replies) {
        await this.reply(event.chatId, reply)
      }

      console.log(
        '[command:reply_sent]',
        JSON.stringify({
          commandName: result.commandName ?? null,
          chatId: event.chatId,
          replyCount: result.replies.length,
        })
      )
    } catch (error) {
      console.error(
        '[command:reply_failed]',
        JSON.stringify({
          commandName: result.commandName ?? null,
          chatId: event.chatId,
          message: error instanceof Error ? error.message : String(error),
        })
      )
      throw error
    }

    return { handled: true, commandName: result.commandName }
  }

  async processReactionEvent(event: ReactionEvent): Promise<{ handled: boolean; commandName?: string }> {
    this.logReaction(event.removed ? 'unclaim' : 'claim', {
      chatId: event.chatId,
      messageId: event.messageId,
      senderId: event.senderId,
      senderPhone: event.senderPhone,
      removed: event.removed,
      emoji: event.emoji,
    })

    if (!event.chatId.endsWith('@g.us')) {
      this.logReaction(event.removed ? 'unclaim' : 'claim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderId: event.senderId,
        ignoredReason: 'not_group_chat',
      })
      return { handled: false }
    }

    const allowedGroups = parseReactionGroupIds()
    if (allowedGroups.size < 1) {
      this.logReaction(event.removed ? 'unclaim' : 'claim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderId: event.senderId,
        ignoredReason: 'no_allowed_groups_configured',
      })
      return { handled: false }
    }

    if (!allowedGroups.has(event.chatId)) {
      this.logReaction(event.removed ? 'unclaim' : 'claim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderId: event.senderId,
        ignoredReason: 'group_not_allowed',
      })
      return { handled: false }
    }

    const eventKey = buildReactionEventKey({
      chatId: event.chatId,
      messageId: event.messageId,
      senderId: event.senderId,
      reactionText: event.removed ? null : event.emoji,
    })
    if (!shouldProcessReactionEvent(eventKey)) {
      this.logReaction(event.removed ? 'unclaim' : 'claim', {
        chatId: event.chatId,
        messageId: event.messageId,
        senderId: event.senderId,
        ignoredReason: 'dedupe_skip',
      })
      return { handled: false }
    }

    return event.removed ? await this.handleReactionUnclaim(event) : await this.handleReactionClaim(event)
  }
}
