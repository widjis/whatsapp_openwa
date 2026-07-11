import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import type { WorkSheet } from 'xlsx';

type Mode = 'today' | 'next-leave' | 'window';

type Args = {
  xlsxPath: string;
  sheetName: string;
  name: string;
  mode: Mode;
  days: number;
  date: string | null;
};

type LeaveContext = {
  rowIndex1Based: number;
  personName: string;
  rowValues: unknown[];
  dateRow: unknown[];
};

function parseEnvPath(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v.length > 0 ? v : null;
}

function normalizeName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toUpperCase();
}

export type LeaveScheduleEntry = {
  status: string | null;
  onsite: boolean;
};

export type LeaveScheduleMatch = {
  matchedKey: string;
  entry: LeaveScheduleEntry;
};

export function normalizeScheduleBaseName(input: string): string {
  const withoutParen = input.replace(/\([^)]*\)/g, ' ');
  const cleaned = withoutParen.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  return normalizeName(cleaned);
}

function isOnsite(status: unknown): boolean {
  if (typeof status !== 'string') return false;
  const s = status.trim().toUpperCase();
  return /^H\d*$/.test(s);
}

function parseYyyyMmDd(input: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0, 0));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function isoDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayTzOffsetUtcDate(offsetHours: number): Date {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const localMs = utcMs + offsetHours * 60 * 60_000;
  const local = new Date(localMs);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 0, 0, 0, 0));
}

export function getTodayIsoDateForOffsetHours(offsetHours: number): string {
  return isoDateUtc(todayTzOffsetUtcDate(offsetHours));
}

function toDateFromCell(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const dt = XLSX.SSF.parse_date_code(value);
    if (!dt) return null;
    const y = dt.y;
    const m = dt.m;
    const d = dt.d;
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  }
  return null;
}

function addDaysUtc(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60_000);
}

function tokenizeKey(key: string): string[] {
  return key.split(' ').filter((t) => t.trim().length > 0);
}

function jaccardSimilarity(aTokens: string[], bTokens: string[]): number {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function getRows(sheet: WorkSheet): unknown[][] {
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) as unknown;
  if (!Array.isArray(raw)) return [];
  const out: unknown[][] = [];
  for (const r of raw) {
    if (Array.isArray(r)) out.push(r);
  }
  return out;
}

function findPersonContext(args: { rows: unknown[][]; name: string; dateHeaderRow1Based: number; dataStartRow1Based: number }): LeaveContext {
  const dateRow = args.rows[args.dateHeaderRow1Based - 1];
  if (!Array.isArray(dateRow)) throw new Error(`Date header row not found at ${args.dateHeaderRow1Based}`);

  const target = normalizeName(args.name);
  const targetBase = normalizeScheduleBaseName(args.name);
  let best: { rowIndex1Based: number; personName: string; rowValues: unknown[] } | null = null;

  const maxRow = Math.min(args.rows.length, args.dataStartRow1Based - 1 + 500);
  for (let rowIdx0 = args.dataStartRow1Based - 1; rowIdx0 < maxRow; rowIdx0 += 1) {
    const row = args.rows[rowIdx0];
    if (!Array.isArray(row)) continue;
    const personRaw = row[2];
    const personName = typeof personRaw === 'string' ? personRaw.trim() : String(personRaw ?? '').trim();
    if (!personName) continue;
    const normalized = normalizeName(personName);
    const personBase = normalizeScheduleBaseName(personName);
    if (normalized === target) {
      return { rowIndex1Based: rowIdx0 + 1, personName, rowValues: row, dateRow };
    }
    if (personBase && targetBase && personBase === targetBase) {
      return { rowIndex1Based: rowIdx0 + 1, personName, rowValues: row, dateRow };
    }
    if (normalized.includes(target) && best === null) {
      best = { rowIndex1Based: rowIdx0 + 1, personName, rowValues: row };
    }
  }

  if (best) return { rowIndex1Based: best.rowIndex1Based, personName: best.personName, rowValues: best.rowValues, dateRow };
  throw new Error(`Name not found: ${args.name}`);
}

function findColByDate(dateRow: unknown[], dUtc: Date, dateShiftDays: number): number | null {
  for (let c0 = 0; c0 < dateRow.length; c0 += 1) {
    const dv = toDateFromCell(dateRow[c0]);
    if (!dv) continue;
    const scheduleDate = addDaysUtc(dv, dateShiftDays);
    if (isoDateUtc(scheduleDate) === isoDateUtc(dUtc)) return c0 + 1;
  }
  return null;
}

export function buildLeaveScheduleIndexForDate(args: {
  xlsxPath: string;
  sheetName: string;
  dateIsoYyyyMmDd: string;
  dateHeaderRow1Based: number;
  dataStartRow1Based: number;
  dateShiftDays: number;
}): Map<string, LeaveScheduleEntry> {
  if (!fs.existsSync(args.xlsxPath)) throw new Error(`XLSX not found: ${args.xlsxPath}`);
  const dUtc = parseYyyyMmDd(args.dateIsoYyyyMmDd);
  if (!dUtc) throw new Error(`Invalid date (expected YYYY-MM-DD): ${args.dateIsoYyyyMmDd}`);

  const workbook = XLSX.readFile(args.xlsxPath, { cellDates: true });
  const sheet = workbook.Sheets[args.sheetName];
  if (!sheet) throw new Error(`Sheet not found: ${args.sheetName}`);

  const rows = getRows(sheet);
  const dateRow = rows[args.dateHeaderRow1Based - 1];
  if (!Array.isArray(dateRow)) throw new Error(`Date header row not found at ${args.dateHeaderRow1Based}`);

  const col = findColByDate(dateRow, dUtc, args.dateShiftDays);
  if (!col) throw new Error(`Date not found in schedule: ${isoDateUtc(dUtc)}`);

  const out = new Map<string, LeaveScheduleEntry>();
  const maxRow = Math.min(rows.length, args.dataStartRow1Based - 1 + 500);
  for (let rowIdx0 = args.dataStartRow1Based - 1; rowIdx0 < maxRow; rowIdx0 += 1) {
    const row = rows[rowIdx0];
    if (!Array.isArray(row)) continue;
    const personRaw = row[2];
    const personName = typeof personRaw === 'string' ? personRaw.trim() : String(personRaw ?? '').trim();
    if (!personName) continue;

    const key = normalizeScheduleBaseName(personName);
    if (!key) continue;
    if (out.has(key)) continue;

    const statusRaw = row[col - 1];
    const status = typeof statusRaw === 'string' ? (statusRaw.trim().length > 0 ? statusRaw.trim() : null) : null;
    out.set(key, { status, onsite: isOnsite(status) });
  }

  return out;
}

export function resolveLeaveScheduleEntry(args: {
  scheduleIndex: Map<string, LeaveScheduleEntry>;
  personName: string;
  allowFuzzy: boolean;
  similarityThreshold: number;
}): LeaveScheduleMatch | null {
  const key = normalizeScheduleBaseName(args.personName);
  if (!key) return null;
  const exact = args.scheduleIndex.get(key);
  if (exact) return { matchedKey: key, entry: exact };
  if (!args.allowFuzzy) return null;

  const targetTokens = tokenizeKey(key);
  let bestKey: string | null = null;
  let bestScore = 0;
  let bestCount = 0;

  for (const candidateKey of args.scheduleIndex.keys()) {
    const candidateTokens = tokenizeKey(candidateKey);
    const score = jaccardSimilarity(targetTokens, candidateTokens);
    if (score > bestScore) {
      bestScore = score;
      bestKey = candidateKey;
      bestCount = 1;
    } else if (score === bestScore && score > 0) {
      bestCount += 1;
    }
  }

  if (!bestKey) return null;
  if (bestScore < args.similarityThreshold) return null;
  if (bestCount > 1) return null;
  const entry = args.scheduleIndex.get(bestKey);
  return entry ? { matchedKey: bestKey, entry } : null;
}

function modeToday(ctx: LeaveContext, dUtc: Date, dateShiftDays: number): unknown {
  const col = findColByDate(ctx.dateRow, dUtc, dateShiftDays);
  if (!col) throw new Error(`Date not found in schedule: ${isoDateUtc(dUtc)}`);
  const status = ctx.rowValues[col - 1] ?? null;
  return {
    mode: 'today',
    name: ctx.personName,
    date: isoDateUtc(dUtc),
    status,
    onsite: isOnsite(status),
    row: ctx.rowIndex1Based,
    column: col,
  };
}

function modeNextLeave(ctx: LeaveContext, dUtc: Date, dateShiftDays: number): unknown {
  const col = findColByDate(ctx.dateRow, dUtc, dateShiftDays);
  if (!col) throw new Error(`Date not found in schedule: ${isoDateUtc(dUtc)}`);
  const todayStatus = ctx.rowValues[col - 1] ?? null;

  for (let c = col + 1; c <= ctx.dateRow.length; c += 1) {
    const dv = toDateFromCell(ctx.dateRow[c - 1]);
    if (!dv) continue;
    const scheduleDate = addDaysUtc(dv, dateShiftDays);
    const st = ctx.rowValues[c - 1];
    if (st === null || typeof st === 'undefined') continue;
    if (!isOnsite(st)) {
      const daysLeft = Math.floor((scheduleDate.getTime() - dUtc.getTime()) / (24 * 60 * 60_000));
      return {
        mode: 'next-leave',
        name: ctx.personName,
        today: isoDateUtc(dUtc),
        today_status: todayStatus,
        next_non_onsite_date: isoDateUtc(scheduleDate),
        next_non_onsite_status: st,
        days_left: daysLeft,
      };
    }
  }

  return {
    mode: 'next-leave',
    name: ctx.personName,
    today: isoDateUtc(dUtc),
    today_status: todayStatus,
    next_non_onsite_date: null,
    next_non_onsite_status: null,
    days_left: null,
  };
}

function modeWindow(ctx: LeaveContext, dUtc: Date, days: number, dateShiftDays: number): unknown {
  const endMs = dUtc.getTime() + days * 24 * 60 * 60_000;
  const statuses: Array<{ date: string; status: unknown; onsite: boolean }> = [];
  for (let c0 = 0; c0 < ctx.dateRow.length; c0 += 1) {
    const dv = toDateFromCell(ctx.dateRow[c0]);
    if (!dv) continue;
    const scheduleDate = addDaysUtc(dv, dateShiftDays);
    const ms = scheduleDate.getTime();
    if (ms < dUtc.getTime() || ms > endMs) continue;
    const status = ctx.rowValues[c0] ?? null;
    statuses.push({ date: isoDateUtc(scheduleDate), status, onsite: isOnsite(status) });
  }
  return { mode: 'window', name: ctx.personName, start_date: isoDateUtc(dUtc), days, statuses };
}

function parseArgs(argv: string[]): Args {
  const defaultsXlsx = parseEnvPath(process.env.LEAVE_SCHEDULE_XLSX_PATH) ?? path.join(process.cwd(), 'data', 'MTI - Leave Schedule (ICT Team).xlsx');
  const out: Args = {
    xlsxPath: defaultsXlsx,
    sheetName: 'Human Resource',
    name: '',
    mode: 'today',
    days: 7,
    date: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--xlsx') out.xlsxPath = argv[i + 1] ?? out.xlsxPath;
    if (a === '--sheet') out.sheetName = argv[i + 1] ?? out.sheetName;
    if (a === '--name') out.name = argv[i + 1] ?? out.name;
    if (a === '--mode') {
      const v = argv[i + 1] ?? out.mode;
      if (v === 'today' || v === 'next-leave' || v === 'window') out.mode = v;
    }
    if (a === '--days') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.days = Math.floor(n);
    }
    if (a === '--date') out.date = argv[i + 1] ?? out.date;
  }

  if (!out.name) throw new Error('Missing --name');
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.xlsxPath)) throw new Error(`XLSX not found: ${args.xlsxPath}`);

  const workbook = XLSX.readFile(args.xlsxPath, { cellDates: true });
  const sheet = workbook.Sheets[args.sheetName];
  if (!sheet) throw new Error(`Sheet not found: ${args.sheetName}`);

  const rows = getRows(sheet);
  const ctx = findPersonContext({ rows, name: args.name, dateHeaderRow1Based: 9, dataStartRow1Based: 10 });

  const tzOffsetRaw = process.env.LEAVE_SCHEDULE_TZ_OFFSET_HOURS;
  const tzOffsetParsed = typeof tzOffsetRaw === 'string' ? Number(tzOffsetRaw) : Number.NaN;
  const tzOffsetHours = Number.isFinite(tzOffsetParsed) ? tzOffsetParsed : 8;
  const dUtc = args.date ? parseYyyyMmDd(args.date) : todayTzOffsetUtcDate(tzOffsetHours);
  if (!dUtc) throw new Error(`Invalid --date (expected YYYY-MM-DD): ${args.date ?? ''}`);

  const dateShiftRaw = process.env.LEAVE_SCHEDULE_DATE_SHIFT_DAYS;
  const dateShiftParsed = typeof dateShiftRaw === 'string' ? Number(dateShiftRaw) : Number.NaN;
  const dateShiftDays = Number.isFinite(dateShiftParsed) ? dateShiftParsed : 1;

  const result =
    args.mode === 'today'
      ? modeToday(ctx, dUtc, dateShiftDays)
      : args.mode === 'next-leave'
        ? modeNextLeave(ctx, dUtc, dateShiftDays)
        : modeWindow(ctx, dUtc, args.days, dateShiftDays);

  console.log(JSON.stringify(result, null, 2));
}

const isDirectRun = (() => {
  try {
    const entry = typeof process.argv[1] === 'string' ? process.argv[1] : '';
    if (!entry) return false;
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  await main();
}
