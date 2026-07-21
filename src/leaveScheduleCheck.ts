import fs from 'node:fs'
import XLSX from 'xlsx'
import type { WorkSheet } from 'xlsx'

export type LeaveScheduleStatus = string | number | null

export type LeaveScheduleEntry = {
  status: LeaveScheduleStatus
  onsite: boolean
  role: 'technician' | 'supervisor' | 'superintendent'
}

export type LeaveScheduleMatch = {
  matchedKey: string
  entry: LeaveScheduleEntry
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase()
}

export function normalizeScheduleBaseName(input: string): string {
  const withoutParen = input.replace(/\([^)]*\)/g, ' ')
  const cleaned = withoutParen.replace(/[^A-Za-z0-9]+/g, ' ').trim()
  return normalizeName(cleaned)
}

function normalizeScheduleStatus(value: unknown): LeaveScheduleStatus {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  // The workbook uses numeric day counters for some local rotation rows.
  if (typeof value === 'number' && Number.isFinite(value)) return value

  return null
}

function isOnsite(status: LeaveScheduleStatus): boolean {
  if (typeof status === 'number') return true
  if (typeof status !== 'string') return false
  return /^H\d*$/.test(status.trim().toUpperCase())
}

function inferRoleFromRow(row: unknown[]): LeaveScheduleEntry['role'] {
  const rosterRaw = typeof row[3] === 'string' ? row[3].trim().toLowerCase() : String(row[3] ?? '').trim().toLowerCase()
  const titleRaw = typeof row[8] === 'string' ? row[8].trim().toLowerCase() : String(row[8] ?? '').trim().toLowerCase()

  if (titleRaw.includes('superintendent')) return 'superintendent'
  if (titleRaw.includes('supervisor')) return 'supervisor'

  // In the current workbook, roster 5:2 is used for supervisor-and-up rows.
  if (rosterRaw === '5:2') return 'supervisor'

  return 'technician'
}

function parseYyyyMmDd(input: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim())
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null

  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date
}

function isoDateUtc(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function todayTzOffsetUtcDate(offsetHours: number): Date {
  const now = new Date()
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000
  const localMs = utcMs + offsetHours * 60 * 60_000
  const local = new Date(localMs)
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 0, 0, 0, 0))
}

export function getTodayIsoDateForOffsetHours(offsetHours: number): string {
  return isoDateUtc(todayTzOffsetUtcDate(offsetHours))
}

function toDateFromCell(value: unknown): Date | null {
  if (value instanceof Date) return value

  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (!parsed) return null
    if (!Number.isFinite(parsed.y) || !Number.isFinite(parsed.m) || !Number.isFinite(parsed.d)) return null
    return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, 0, 0, 0, 0))
  }

  return null
}

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60_000)
}

function tokenizeKey(key: string): string[] {
  return key.split(' ').filter((token) => token.trim().length > 0)
}

function jaccardSimilarity(aTokens: string[], bTokens: string[]): number {
  const a = new Set(aTokens)
  const b = new Set(bTokens)
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0

  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection += 1
  }

  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

function tokensContainedInOrderlessSubset(targetTokens: string[], candidateTokens: string[]): boolean {
  if (targetTokens.length === 0) return false
  const candidateSet = new Set(candidateTokens)
  return targetTokens.every((token) => candidateSet.has(token))
}

function getRows(sheet: WorkSheet): unknown[][] {
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) as unknown
  if (!Array.isArray(raw)) return []

  const rows: unknown[][] = []
  for (const row of raw) {
    if (Array.isArray(row)) rows.push(row)
  }
  return rows
}

function findColByDate(dateRow: unknown[], date: Date, dateShiftDays: number): number | null {
  for (let index = 0; index < dateRow.length; index += 1) {
    const cellDate = toDateFromCell(dateRow[index])
    if (!cellDate) continue
    const scheduleDate = addDaysUtc(cellDate, dateShiftDays)
    if (isoDateUtc(scheduleDate) === isoDateUtc(date)) return index + 1
  }
  return null
}

export function buildLeaveScheduleIndexForDate(args: {
  xlsxPath: string
  sheetName: string
  dateIsoYyyyMmDd: string
  dateHeaderRow1Based: number
  dataStartRow1Based: number
  dateShiftDays: number
  superintendentCount?: number
  supervisorCount?: number
}): Map<string, LeaveScheduleEntry> {
  if (!fs.existsSync(args.xlsxPath)) throw new Error(`XLSX not found: ${args.xlsxPath}`)

  const targetDate = parseYyyyMmDd(args.dateIsoYyyyMmDd)
  if (!targetDate) throw new Error(`Invalid date (expected YYYY-MM-DD): ${args.dateIsoYyyyMmDd}`)

  const workbook = XLSX.readFile(args.xlsxPath, { cellDates: true })
  const sheet = workbook.Sheets[args.sheetName]
  if (!sheet) throw new Error(`Sheet not found: ${args.sheetName}`)

  const rows = getRows(sheet)
  const dateRow = rows[args.dateHeaderRow1Based - 1]
  if (!Array.isArray(dateRow)) throw new Error(`Date header row not found at ${args.dateHeaderRow1Based}`)

  const column = findColByDate(dateRow, targetDate, args.dateShiftDays)
  if (!column) throw new Error(`Date not found in schedule: ${isoDateUtc(targetDate)}`)

  const result = new Map<string, LeaveScheduleEntry>()
  const maxRow = Math.min(rows.length, args.dataStartRow1Based - 1 + 500)
  for (let rowIndex = args.dataStartRow1Based - 1; rowIndex < maxRow; rowIndex += 1) {
    const row = rows[rowIndex]
    if (!Array.isArray(row)) continue

    const personRaw = row[2]
    const personName = typeof personRaw === 'string' ? personRaw.trim() : String(personRaw ?? '').trim()
    if (!personName) continue

    const key = normalizeScheduleBaseName(personName)
    if (!key || result.has(key)) continue

    const status = normalizeScheduleStatus(row[column - 1])
    const role = inferRoleFromRow(row)

    result.set(key, { status, onsite: isOnsite(status), role })
  }

  return result
}

export function resolveLeaveScheduleEntry(args: {
  scheduleIndex: Map<string, LeaveScheduleEntry>
  personName: string
  allowFuzzy: boolean
  similarityThreshold: number
}): LeaveScheduleMatch | null {
  const key = normalizeScheduleBaseName(args.personName)
  if (!key) return null

  const exact = args.scheduleIndex.get(key)
  if (exact) return { matchedKey: key, entry: exact }
  if (!args.allowFuzzy) return null

  const targetTokens = tokenizeKey(key)
  let containmentBestKey: string | null = null
  let containmentBestExtraTokens = Number.POSITIVE_INFINITY
  let containmentBestCount = 0

  for (const candidateKey of args.scheduleIndex.keys()) {
    const candidateTokens = tokenizeKey(candidateKey)
    if (!tokensContainedInOrderlessSubset(targetTokens, candidateTokens)) continue

    const extraTokens = Math.max(0, candidateTokens.length - targetTokens.length)
    if (extraTokens < containmentBestExtraTokens) {
      containmentBestExtraTokens = extraTokens
      containmentBestKey = candidateKey
      containmentBestCount = 1
    } else if (extraTokens === containmentBestExtraTokens) {
      containmentBestCount += 1
    }
  }

  if (containmentBestKey && containmentBestCount === 1) {
    const containmentEntry = args.scheduleIndex.get(containmentBestKey)
    if (containmentEntry) return { matchedKey: containmentBestKey, entry: containmentEntry }
  }

  let bestKey: string | null = null
  let bestScore = 0
  let bestCount = 0

  for (const candidateKey of args.scheduleIndex.keys()) {
    const candidateTokens = tokenizeKey(candidateKey)
    const score = jaccardSimilarity(targetTokens, candidateTokens)
    if (score > bestScore) {
      bestScore = score
      bestKey = candidateKey
      bestCount = 1
    } else if (score === bestScore && score > 0) {
      bestCount += 1
    }
  }

  if (!bestKey || bestScore < args.similarityThreshold || bestCount > 1) return null

  const entry = args.scheduleIndex.get(bestKey)
  return entry ? { matchedKey: bestKey, entry } : null
}
