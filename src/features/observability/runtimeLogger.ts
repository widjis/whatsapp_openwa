import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import util from 'node:util'

export type RuntimeLoggerConfig = {
  enabled: boolean
  directory: string
  captureConsole: boolean
  maxFiles: number
}

export type RuntimeLogFileInfo = {
  name: string
  path: string
  sizeBytes: number
  modifiedAt: string
}

export type RuntimeLogger = {
  config: RuntimeLoggerConfig
  getLatestLogFilePath(): string
  listLogFiles(limit?: number): Promise<RuntimeLogFileInfo[]>
  readRecentLines(args?: { fileName?: string; lines?: number }): Promise<{
    fileName: string
    filePath: string
    lines: string[]
  }>
  log(level: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]): void
}

type ConsoleMethodName = 'log' | 'info' | 'warn' | 'error' | 'debug'

const LOG_FILE_PREFIX = 'app-'
const LOG_FILE_SUFFIX = '.log'
const REDACTED = '[REDACTED]'
const SENSITIVE_KEY_PATTERN = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|set-cookie|refresh[-_]?token|access[-_]?token)/i

function normalizeDatePart(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function currentLogFileName(): string {
  return `${LOG_FILE_PREFIX}${normalizeDatePart(new Date())}${LOG_FILE_SUFFIX}`
}

function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName)
  if (!/^app-\d{4}-\d{2}-\d{2}\.log$/i.test(base)) {
    throw new Error('Invalid log file name')
  }
  return base
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

function redactString(value: string): string {
  let redacted = value

  redacted = redacted.replace(/\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi, `$1 ${REDACTED}`)
  redacted = redacted.replace(
    /\b(x-api-key|api-key|apikey|authorization|token|access_token|refresh_token|password|secret)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (_match, key) => `${key}=${REDACTED}`
  )

  return redacted
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value
  if (typeof value === 'bigint') return String(value)

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: typeof value.stack === 'string' ? redactString(value.stack) : undefined,
      cause: sanitizeValue((value as Error & { cause?: unknown }).cause, seen),
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen))
  }

  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = REDACTED
      continue
    }
    output[key] = sanitizeValue(nested, seen)
  }
  return output
}

function formatArgs(args: unknown[]): string {
  return stripAnsi(
    util.formatWithOptions(
      {
        colors: false,
        depth: 6,
        breakLength: Number.POSITIVE_INFINITY,
        maxArrayLength: 100,
      },
      ...args.map((arg) => sanitizeValue(arg))
    )
  )
}

function toLevel(method: ConsoleMethodName): 'debug' | 'info' | 'warn' | 'error' {
  if (method === 'error') return 'error'
  if (method === 'warn') return 'warn'
  if (method === 'debug') return 'debug'
  return 'info'
}

export function initializeRuntimeLogger(config: RuntimeLoggerConfig): RuntimeLogger {
  fs.mkdirSync(config.directory, { recursive: true })

  const originalConsole: Record<ConsoleMethodName, (...args: unknown[]) => void> = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }

  let writeInProgress = false

  function getLogFilePath(fileName = currentLogFileName()): string {
    return path.join(config.directory, fileName)
  }

  function pruneOldFilesSync(): void {
    if (config.maxFiles <= 0) return

    try {
      const files = fs
        .readdirSync(config.directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.startsWith(LOG_FILE_PREFIX) && entry.name.endsWith(LOG_FILE_SUFFIX))
        .map((entry) => entry.name)
        .sort()
        .reverse()

      for (const fileName of files.slice(config.maxFiles)) {
        fs.rmSync(path.join(config.directory, fileName), { force: true })
      }
    } catch (error) {
      originalConsole.error('[logger:prune_failed]', error)
    }
  }

  function writeLine(level: 'debug' | 'info' | 'warn' | 'error', args: unknown[]): void {
    if (!config.enabled || writeInProgress) return

    const rendered = formatArgs(args)
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${rendered}\n`

    try {
      writeInProgress = true
      fs.appendFileSync(getLogFilePath(), line, 'utf8')
      pruneOldFilesSync()
    } catch (error) {
      originalConsole.error('[logger:write_failed]', error)
    } finally {
      writeInProgress = false
    }
  }

  function installConsoleCapture(): void {
    if (!config.captureConsole) return

    const methods: ConsoleMethodName[] = ['log', 'info', 'warn', 'error', 'debug']
    for (const method of methods) {
      console[method] = (...args: unknown[]) => {
        writeLine(toLevel(method), args)
        originalConsole[method](...args)
      }
    }
  }

  function log(level: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]): void {
    writeLine(level, args)
    if (level === 'error') {
      originalConsole.error(...args)
      return
    }
    if (level === 'warn') {
      originalConsole.warn(...args)
      return
    }
    if (level === 'debug') {
      originalConsole.debug(...args)
      return
    }
    originalConsole.log(...args)
  }

  function installProcessDiagnostics(): void {
    process.on('uncaughtExceptionMonitor', (error, origin) => {
      writeLine('error', ['[process:uncaught_exception]', { origin, error }])
    })

    process.on('unhandledRejection', (reason) => {
      writeLine('error', ['[process:unhandled_rejection]', reason])
      originalConsole.error('[process:unhandled_rejection]', reason)
    })

    process.on('warning', (warning) => {
      writeLine('warn', ['[process:warning]', warning])
    })
  }

  installConsoleCapture()
  installProcessDiagnostics()
  writeLine('info', [
    '[logger:ready]',
    JSON.stringify({
      directory: config.directory,
      captureConsole: config.captureConsole,
      maxFiles: config.maxFiles,
    }),
  ])

  async function listLogFiles(limit = 20): Promise<RuntimeLogFileInfo[]> {
    const names = await fsPromises.readdir(config.directory)
    const fileInfos = await Promise.all(
      names
        .filter((name) => name.startsWith(LOG_FILE_PREFIX) && name.endsWith(LOG_FILE_SUFFIX))
        .map(async (name) => {
          const filePath = path.join(config.directory, name)
          const stats = await fsPromises.stat(filePath)
          return {
            name,
            path: filePath,
            sizeBytes: stats.size,
            modifiedAt: stats.mtime.toISOString(),
          }
        })
    )

    return fileInfos
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, Math.max(1, limit))
  }

  async function readRecentLines(args?: { fileName?: string; lines?: number }): Promise<{
    fileName: string
    filePath: string
    lines: string[]
  }> {
    const linesToRead = Math.min(2_000, Math.max(1, args?.lines ?? 200))
    const fileName = args?.fileName ? sanitizeFileName(args.fileName) : currentLogFileName()
    const filePath = getLogFilePath(fileName)
    const stats = await fsPromises.stat(filePath)
    const readBytes = Math.min(stats.size, 512 * 1024)
    const start = Math.max(0, stats.size - readBytes)
    const handle = await fsPromises.open(filePath, 'r')

    try {
      const buffer = Buffer.alloc(readBytes)
      await handle.read(buffer, 0, readBytes, start)
      const text = buffer.toString('utf8')
      const tailLines = text.split(/\r?\n/).filter((line) => line.length > 0).slice(-linesToRead)
      return { fileName, filePath, lines: tailLines }
    } finally {
      await handle.close()
    }
  }

  return {
    config,
    getLatestLogFilePath: () => getLogFilePath(),
    listLogFiles,
    readRecentLines,
    log,
  }
}
