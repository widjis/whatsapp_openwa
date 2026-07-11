import type { Express, Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { normalizeInboundMessageEvent } from '../../channel/eventNormalizer.js';
import { getDefaultWebhookEvents, type WebhookCaptureStore, type WebhookService } from '../../channel/webhookService.js';
import type { InboundCommandService } from '../../inbound/commandService.js';

type RegisterWebhookRoutesDeps = {
  app: Express;
  checkIp: (req: Request, res: Response, next: () => void) => void;
  captureStore: WebhookCaptureStore;
  webhookService: WebhookService;
  commandService: InboundCommandService;
  defaultWebhookUrl?: string;
  defaultWebhookSecret?: string;
};

function toHeaderRecord(headers: Request['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.join(', ');
    }
  }
  return out;
}

function hasValidationError(req: Request, res: Response): boolean {
  const errors = validationResult(req).formatWith((error) => error.msg);
  if (!errors.isEmpty()) {
    res.status(422).json({ status: false, errors: errors.mapped() });
    return true;
  }
  return false;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function truncate(value: string, maxLength = 120): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function extractIncomingEventType(body: unknown): string | null {
  const record = toRecord(body);
  if (!record) return null;
  const nested = toRecord(record.payload) ?? toRecord(record.data) ?? toRecord(record.message);
  return firstString(record.event, record.type, nested?.event, nested?.type);
}

function extractIncomingSessionId(body: unknown): string | null {
  const record = toRecord(body);
  if (!record) return null;
  const nested = toRecord(record.payload) ?? toRecord(record.data) ?? toRecord(record.message);
  return firstString(record.sessionId, record.session_id, nested?.sessionId, nested?.session_id);
}

function summarizeBody(body: unknown): Record<string, unknown> {
  const record = toRecord(body);
  if (!record) return { bodyType: typeof body };

  const payload = toRecord(record.payload) ?? toRecord(record.data) ?? record;
  const payloadMessage = toRecord(payload.message);
  const key = payloadMessage ? toRecord(payloadMessage.key) : null;
  const previewText = firstString(
    payload.text,
    payload.body,
    payload.messageText,
    payloadMessage?.text,
    toRecord(payloadMessage?.extendedTextMessage)?.text,
    toRecord(payloadMessage?.imageMessage)?.caption,
    toRecord(payloadMessage?.videoMessage)?.caption
  );

  return {
    topLevelKeys: Object.keys(record),
    payloadKeys: Object.keys(payload),
    eventType: extractIncomingEventType(body),
    sessionId: extractIncomingSessionId(body),
    chatId: firstString(payload.chatId, payload.remoteJid, payload.from, payload.to, payloadMessage?.chatId, key?.remoteJid),
    senderId: firstString(payload.senderId, payload.author, payload.participant, payload.from, payloadMessage?.senderId, key?.participant),
    messageId: firstString(payload.messageId, payload.id, payloadMessage?.messageId, key?.id),
    textPreview: previewText ? truncate(previewText) : null,
  };
}

export function registerWebhookRoutes(deps: RegisterWebhookRoutesDeps) {
  deps.app.post('/channel/webhooks/openwa', async (req: Request, res: Response) => {
    try {
      console.log('[webhook:received]', JSON.stringify({
        path: req.path,
        method: req.method,
        eventType: extractIncomingEventType(req.body),
        sessionId: extractIncomingSessionId(req.body),
        remoteAddress: req.ip,
        summary: summarizeBody(req.body),
      }));

      const capture = await deps.captureStore.save({
        headers: toHeaderRecord(req.headers),
        payload: req.body,
      });
      console.log('[webhook:capture_saved]', JSON.stringify({
        captureId: capture.captureId,
        eventType: capture.eventType,
        sessionId: capture.sessionId,
      }));

      const normalizedMessage = normalizeInboundMessageEvent(req.body);
      if (normalizedMessage) {
        console.log('[webhook:normalized]', JSON.stringify({
          eventType: normalizedMessage.eventType,
          sessionId: normalizedMessage.sessionId,
          chatId: normalizedMessage.chatId,
          senderId: normalizedMessage.senderId,
          isGroup: normalizedMessage.isGroup,
          messageId: normalizedMessage.messageId,
          textPreview: truncate(normalizedMessage.text),
        }));
      } else {
        console.log('[webhook:normalize_skipped]', JSON.stringify({
          eventType: extractIncomingEventType(req.body),
          summary: summarizeBody(req.body),
        }));
      }

      const processed = normalizedMessage ? await deps.commandService.processInboundMessage(normalizedMessage) : { handled: false };
      console.log('[webhook:processed]', JSON.stringify({
        eventType: normalizedMessage?.eventType ?? extractIncomingEventType(req.body),
        handled: processed.handled,
        commandName: processed.commandName ?? null,
      }));

      res.status(202).json({
        status: true,
        captured: {
          captureId: capture.captureId,
          eventType: capture.eventType,
          sessionId: capture.sessionId,
          capturedAt: capture.capturedAt,
        },
        processed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[webhook:error]', error);
      res.status(500).json({ status: false, message });
    }
  });

  deps.app.get(
    '/channel/webhooks/captures',
    deps.checkIp,
    [query('limit').optional().isInt({ min: 1, max: 100 })],
    async (req: Request, res: Response) => {
      if (hasValidationError(req, res)) return;

      try {
        const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
        const captures = await deps.captureStore.listLatest(Number.isFinite(limitRaw) ? limitRaw : 20);
        res.status(200).json({ status: true, captures });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ status: false, message });
      }
    }
  );

  deps.app.get(
    '/channel/webhooks/captures/latest',
    deps.checkIp,
    [query('eventType').trim().notEmpty().withMessage('eventType cannot be empty')],
    async (req: Request, res: Response) => {
      if (hasValidationError(req, res)) return;

      try {
        const eventType = String(req.query.eventType);
        const capture = await deps.captureStore.getLatestByEventType(eventType);
        if (!capture) {
          res.status(404).json({ status: false, message: `No capture found for eventType: ${eventType}` });
          return;
        }

        res.status(200).json({ status: true, capture });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ status: false, message });
      }
    }
  );

  deps.app.get('/channel/webhooks', deps.checkIp, async (_req: Request, res: Response) => {
    try {
      const webhooks = await deps.webhookService.listCurrentSessionWebhooks();
      res.status(200).json({ status: true, webhooks });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ status: false, message });
    }
  });

  deps.app.post(
    '/channel/webhooks/register',
    deps.checkIp,
    [
      body('url').optional().isString(),
      body('secret').optional().isString(),
      body('retryCount').optional().isInt({ min: 0, max: 5 }),
      body('events').optional().isArray({ min: 1 }),
    ],
    async (req: Request, res: Response) => {
      if (hasValidationError(req, res)) return;

      try {
        const bodyValue = req.body as {
          url?: string;
          secret?: string;
          retryCount?: number;
          events?: string[];
        };

        const url = bodyValue.url?.trim() || deps.defaultWebhookUrl;
        if (!url) {
          res.status(400).json({ status: false, message: 'Webhook URL is required. Set OPENWA_WEBHOOK_URL or pass body.url.' });
          return;
        }

        const result = await deps.webhookService.ensureCurrentSessionWebhook({
          url,
          secret: bodyValue.secret?.trim() || deps.defaultWebhookSecret,
          retryCount: typeof bodyValue.retryCount === 'number' ? bodyValue.retryCount : 3,
          events: Array.isArray(bodyValue.events) && bodyValue.events.length > 0 ? bodyValue.events : getDefaultWebhookEvents(),
        });

        res.status(result.created ? 201 : 200).json({ status: true, created: result.created, webhook: result.webhook });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ status: false, message });
      }
    }
  );
}
