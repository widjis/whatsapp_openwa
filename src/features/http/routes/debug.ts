import type { Express, Request, Response } from 'express'
import { query, validationResult } from 'express-validator'
import type { RuntimeLogger } from '../../observability/runtimeLogger.js'

type RegisterDebugRoutesDeps = {
  app: Express
  checkIp: (req: Request, res: Response, next: () => void) => void
  logger: RuntimeLogger
  enabled: boolean
}

function hasValidationError(req: Request, res: Response): boolean {
  const errors = validationResult(req).formatWith((error) => error.msg)
  if (!errors.isEmpty()) {
    res.status(422).json({ status: false, errors: errors.mapped() })
    return true
  }
  return false
}

export function registerDebugRoutes(deps: RegisterDebugRoutesDeps): void {
  if (!deps.enabled) return

  deps.app.get('/debug/logs/files', deps.checkIp, async (_req: Request, res: Response) => {
    try {
      const files = await deps.logger.listLogFiles(30)
      res.status(200).json({
        status: true,
        directory: deps.logger.config.directory,
        files,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[debug:logs_files_error]', error)
      res.status(500).json({ status: false, message })
    }
  })

  deps.app.get(
    '/debug/logs',
    deps.checkIp,
    [
      query('file').optional().isString(),
      query('lines').optional().isInt({ min: 1, max: 2000 }),
    ],
    async (req: Request, res: Response) => {
      if (hasValidationError(req, res)) return

      try {
        const file = typeof req.query.file === 'string' ? req.query.file : undefined
        const lines = typeof req.query.lines === 'string' ? Number(req.query.lines) : undefined
        const result = await deps.logger.readRecentLines({ fileName: file, lines })

        res.status(200).json({
          status: true,
          fileName: result.fileName,
          filePath: result.filePath,
          lineCount: result.lines.length,
          lines: result.lines,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[debug:logs_read_error]', error)
        res.status(500).json({ status: false, message })
      }
    }
  )
}
