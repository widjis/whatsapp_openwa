import dotenv from 'dotenv'
import fs from 'node:fs/promises'
import path from 'node:path'
import XLSX from 'xlsx'

dotenv.config()

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function isoDateUtc(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function todayIsoForOffsetHours(offsetHours: number): string {
  const now = new Date()
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000
  const localMs = utcMs + offsetHours * 60 * 60_000
  const local = new Date(localMs)
  const utcDate = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 0, 0, 0, 0))
  return isoDateUtc(utcDate)
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

function normalizeScheduleStatus(value: unknown): string | number | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function isOnsite(status: unknown): boolean {
  if (typeof status === 'number') return true
  if (typeof status !== 'string') return false
  return /^H\d*$/.test(status.trim().toUpperCase())
}

function shouldExclude(name: string): boolean {
  const normalized = name.toUpperCase()
  return normalized.includes('SUPERVISOR') || normalized.includes('SUPERINTENDANT') || normalized.includes('SUPERINTENDENT')
}

function getRows(sheet: XLSX.WorkSheet): unknown[][] {
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) as unknown
  if (!Array.isArray(raw)) return []
  return raw.filter((row): row is unknown[] => Array.isArray(row))
}

function findDateColumn(dateRow: unknown[], targetIso: string, dateShiftDays: number): number | null {
  for (let index = 0; index < dateRow.length; index += 1) {
    const cellDate = toDateFromCell(dateRow[index])
    if (!cellDate) continue
    const shifted = addDaysUtc(cellDate, dateShiftDays)
    if (isoDateUtc(shifted) === targetIso) return index
  }
  return null
}

async function main(): Promise<void> {
  const dataDir = process.env.DATA_DIR?.trim() ? unquote(process.env.DATA_DIR.trim()) : path.join(process.cwd(), 'data')
  const xlsxPathRaw =
    process.env.DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH?.trim() && process.env.DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH.trim().length > 0
      ? unquote(process.env.DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH.trim())
      : path.join(dataDir, 'MTI - Leave Schedule (ICT Team).xlsx')
  const xlsxPath = path.isAbsolute(xlsxPathRaw) ? xlsxPathRaw : path.join(process.cwd(), xlsxPathRaw)
  const sheetName = process.env.DISPATCHER_LEAVE_SCHEDULE_SHEET?.trim() ? unquote(process.env.DISPATCHER_LEAVE_SCHEDULE_SHEET.trim()) : 'Human Resource'
  const tzOffsetHours = Math.floor(parseNumber(process.env.DISPATCHER_LEAVE_SCHEDULE_TZ_OFFSET_HOURS, 8))
  const dateShiftDays = Math.floor(parseNumber(process.env.DISPATCHER_LEAVE_SCHEDULE_DATE_SHIFT_DAYS, 1))
  const dateIso = todayIsoForOffsetHours(tzOffsetHours)

  const workbook = XLSX.readFile(xlsxPath, { cellDates: true })
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) throw new Error(`Sheet not found: ${sheetName}`)

  const rows = getRows(sheet)
  const dateHeaderRow1Based = 9
  const dataStartRow1Based = 10
  const dateRow = rows[dateHeaderRow1Based - 1] ?? []
  const dateColumnIndex0 = findDateColumn(dateRow, dateIso, dateShiftDays)
  if (dateColumnIndex0 === null) throw new Error(`Date not found in header row: ${dateIso}`)

  const included: Array<{ name: string; status: string | null; onsite: boolean }> = []
  const excluded: Array<{ name: string; status: string | null }> = []

  const maxRow = Math.min(rows.length, dataStartRow1Based - 1 + 500)
  for (let rowIndex = dataStartRow1Based - 1; rowIndex < maxRow; rowIndex += 1) {
    const row = rows[rowIndex]
    const personRaw = row?.[2]
    const name = typeof personRaw === 'string' ? personRaw.trim() : String(personRaw ?? '').trim()
    if (!name) continue

    const status = normalizeScheduleStatus(row?.[dateColumnIndex0])

    if (shouldExclude(name)) {
      excluded.push({ name, status })
      continue
    }

    included.push({ name, status, onsite: isOnsite(status) })
  }

  const onsiteCount = included.filter((entry) => entry.onsite).length
  const reportLines: string[] = []
  reportLines.push(`date=${dateIso}`)
  reportLines.push(`sheet=${sheetName}`)
  reportLines.push(`xlsx=${xlsxPath}`)
  reportLines.push(`included=${included.length}`)
  reportLines.push(`excluded=${excluded.length}`)
  reportLines.push(`onsite=${onsiteCount}`)
  reportLines.push('')
  reportLines.push('Included:')
  for (const entry of included) {
    reportLines.push(`${entry.name}\t${entry.status ?? ''}\t${entry.onsite ? 'onsite' : ''}`.trimEnd())
  }
  reportLines.push('')
  reportLines.push('Excluded:')
  for (const entry of excluded) {
    reportLines.push(`${entry.name}\t${entry.status ?? ''}`.trimEnd())
  }

  const reportDir = path.join(dataDir, 'leave')
  await fs.mkdir(reportDir, { recursive: true })
  const reportPath = path.join(reportDir, `leave-schedule-readout-${dateIso}.txt`)
  await fs.writeFile(reportPath, reportLines.join('\n'))

  console.log(JSON.stringify({ dateIso, sheetName, xlsxPath, included: included.length, excluded: excluded.length, onsite: onsiteCount, reportPath }))
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(JSON.stringify({ status: false, message }))
  process.exitCode = 1
})
