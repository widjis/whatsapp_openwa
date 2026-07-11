import type { Express, Request, Response } from 'express'
import { body, validationResult } from 'express-validator'
import type { SessionService } from '../../channel/sessionService.js'

type RegisterChannelRoutesDeps = {
  app: Express
  checkIp: (req: Request, res: Response, next: () => void) => void
  sessions: SessionService
}

function hasValidationError(req: Request, res: Response): boolean {
  const errors = validationResult(req).formatWith((error) => error.msg)
  if (!errors.isEmpty()) {
    res.status(422).json({ status: false, errors: errors.mapped() })
    return true
  }
  return false
}

export function registerChannelRoutes(deps: RegisterChannelRoutesDeps) {
  deps.app.get('/channel/session', deps.checkIp, async (_req, res) => {
    try {
      const session = await deps.sessions.getCurrentSession()
      res.status(200).json({ status: true, session })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ status: false, message })
    }
  })

  deps.app.get('/channel/session/status', deps.checkIp, async (_req, res) => {
    try {
      const session = await deps.sessions.getCurrentSession()
      res.status(200).json({ status: true, session: { id: session.id, name: session.name, status: session.status } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ status: false, message })
    }
  })

  deps.app.get('/channel/session/qr', deps.checkIp, async (_req, res) => {
    try {
      const qr = await deps.sessions.getCurrentQrCode()
      res.status(200).json({ status: true, qr })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ status: false, message })
    }
  })

  deps.app.post('/channel/session/start', deps.checkIp, async (_req, res) => {
    try {
      const session = await deps.sessions.startCurrentSession()
      res.status(200).json({ status: true, session })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ status: false, message })
    }
  })

  deps.app.post('/channel/session/stop', deps.checkIp, async (_req, res) => {
    try {
      const session = await deps.sessions.stopCurrentSession()
      res.status(200).json({ status: true, session })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ status: false, message })
    }
  })

  deps.app.post(
    '/channel/session/pairing-code',
    deps.checkIp,
    [body('phoneNumber').trim().notEmpty().withMessage('phoneNumber cannot be empty')],
    async (req: Request, res: Response) => {
      if (hasValidationError(req, res)) return

      try {
        const { phoneNumber } = req.body as { phoneNumber: string }
        const pairing = await deps.sessions.requestCurrentPairingCode(phoneNumber)
        res.status(200).json({ status: true, pairing })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        res.status(500).json({ status: false, message })
      }
    }
  )
}
