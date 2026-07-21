import type { Express, Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import {
  normalizeOpenwaEvent,
  type InboundMessageEvent,
  type ReactionEvent,
} from '../../channel/eventNormalizer.js';
import { getDefaultWebhookEvents, type WebhookCaptureStore, type WebhookService } from '../../channel/webhookService.js';
import { loadTicketNotification } from '../../tickets/claimStore.js';

type CommandProcessResult = {
  handled: boolean;
  commandName?: string;
};

type WebhookCommandService = {
  processInboundMessage(event: InboundMessageEvent): Promise<CommandProcessResult>;
  processReactionEvent(event: ReactionEvent): Promise<CommandProcessResult>;
};

type WebhookN8nService = {
  processInboundMessage(event: InboundMessageEvent): Promise<{ handled: boolean; replyText?: string }>;
};

type RegisterWebhookRoutesDeps = {
  app: Express;
  checkIp: (req: Request, res: Response, next: () => void) => void;
  captureStore: WebhookCaptureStore;
  webhookService: WebhookService;
  commandService: WebhookCommandService;
  n8n?: WebhookN8nService;
  defaultWebhookUrl?: string;
  defaultWebhookSecret?: string;
};

type ProcessWebhookPayloadArgs = {
  payload: unknown;
  headers: Record<string, string>;
  path: string;
  method: string;
  remoteAddress: string;
  captureStore: WebhookCaptureStore;
  commandService: WebhookCommandService;
  n8n?: WebhookN8nService;
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

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};

  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') {
      out[key] = raw;
      continue;
    }
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = String(raw);
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

function formatLogValue(value: unknown): string {
  if (value === undefined) return '-';
  if (value === null) return '<null>';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) {
    const text = value.join(',');
    return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
  }
  if (typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      return text.length <= 100 ? text : `${text.slice(0, 97)}...`;
    } catch {
      return '[object]';
    }
  }

  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return '""';
  return text.length <= 100 ? text : `${text.slice(0, 97)}...`;
}

function formatLogLine(details: Record<string, unknown>, preferredOrder: string[] = []): string {
  const keys = new Set<string>([...preferredOrder, ...Object.keys(details)]);
  return Array.from(keys)
    .filter((key) => key in details)
    .map((key) => `${key}=${formatLogValue(details[key])}`)
    .join(' | ');
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

function logWebhook(tag: string, details: Record<string, unknown>, preferredOrder: string[] = []): void {
  console.log(tag, formatLogLine(details, preferredOrder));
}

async function processWebhookPayload(args: ProcessWebhookPayloadArgs): Promise<{
  captured: {
    captureId: string;
    eventType: string | null;
    sessionId: string | null;
    capturedAt: string;
  };
  processed: CommandProcessResult;
}> {
  const incomingSummary = summarizeBody(args.payload);
  logWebhook(
    '[webhook:received]',
    {
      eventType: extractIncomingEventType(args.payload),
      sessionId: extractIncomingSessionId(args.payload),
      path: args.path,
      method: args.method,
      remoteAddress: args.remoteAddress,
      chatId: incomingSummary.chatId,
      senderId: incomingSummary.senderId,
      messageId: incomingSummary.messageId,
      textPreview: incomingSummary.textPreview,
    },
    ['eventType', 'sessionId', 'chatId', 'senderId', 'messageId', 'textPreview', 'path', 'method', 'remoteAddress']
  );

  const capture = await args.captureStore.save({
    headers: args.headers,
    payload: args.payload,
  });
  logWebhook(
    '[webhook:capture_saved]',
    {
      eventType: capture.eventType,
      sessionId: capture.sessionId,
      captureId: capture.captureId,
    },
    ['eventType', 'sessionId', 'captureId']
  );

  const normalizedEvent = normalizeOpenwaEvent(args.payload);
  if (normalizedEvent?.eventType === 'message.received') {
    const normalizedMessage = normalizedEvent;
    logWebhook(
      '[webhook:normalized]',
      {
        eventType: normalizedMessage.eventType,
        sessionId: normalizedMessage.sessionId,
        chatId: normalizedMessage.chatId,
        senderId: normalizedMessage.senderId,
        isGroup: normalizedMessage.isGroup,
        messageId: normalizedMessage.messageId,
        textPreview: truncate(normalizedMessage.text),
      },
      ['eventType', 'sessionId', 'chatId', 'senderId', 'isGroup', 'messageId', 'textPreview']
    );
  } else if (normalizedEvent?.eventType === 'message.reaction') {
    logWebhook(
      '[webhook:normalized]',
      {
        eventType: normalizedEvent.eventType,
        sessionId: normalizedEvent.sessionId,
        chatId: normalizedEvent.chatId,
        senderId: normalizedEvent.senderId,
        senderPhone: normalizedEvent.senderPhone,
        messageId: normalizedEvent.messageId,
        emoji: normalizedEvent.emoji,
        removed: normalizedEvent.removed,
      },
      ['eventType', 'sessionId', 'chatId', 'senderId', 'senderPhone', 'messageId', 'emoji', 'removed']
    );
  } else {
    logWebhook(
      '[webhook:normalize_skipped]',
      {
        eventType: extractIncomingEventType(args.payload),
        sessionId: extractIncomingSessionId(args.payload),
        chatId: incomingSummary.chatId,
        senderId: incomingSummary.senderId,
        messageId: incomingSummary.messageId,
        textPreview: incomingSummary.textPreview,
      },
      ['eventType', 'sessionId', 'chatId', 'senderId', 'messageId', 'textPreview']
    );
  }

  let processed: CommandProcessResult = { handled: false };
  if (normalizedEvent?.eventType === 'message.received') {
    processed = await args.commandService.processInboundMessage(normalizedEvent);
    if (!processed.handled && args.n8n) {
      const n8nResult = await args.n8n.processInboundMessage(normalizedEvent);
      if (n8nResult.handled) {
        processed = { handled: true, commandName: 'n8n' };
      }
    }
  } else if (normalizedEvent?.eventType === 'message.reaction') {
    processed = await args.commandService.processReactionEvent(normalizedEvent);
  }
  logWebhook(
    '[webhook:processed]',
    {
      eventType: normalizedEvent?.eventType ?? extractIncomingEventType(args.payload),
      handled: processed.handled,
      commandName: processed.commandName ?? null,
    },
    ['eventType', 'handled', 'commandName']
  );

  return {
    captured: {
      captureId: capture.captureId,
      eventType: capture.eventType,
      sessionId: capture.sessionId,
      capturedAt: capture.capturedAt,
    },
    processed,
  };
}

export function registerWebhookRoutes(deps: RegisterWebhookRoutesDeps) {
  deps.app.post('/channel/webhooks/openwa', async (req: Request, res: Response) => {
    try {
      const result = await processWebhookPayload({
        payload: req.body,
        headers: toHeaderRecord(req.headers),
        path: req.path,
        method: req.method,
        remoteAddress: req.ip ?? '',
        captureStore: deps.captureStore,
        commandService: deps.commandService,
        n8n: deps.n8n,
      });
      res.status(202).json({
        status: true,
        captured: result.captured,
        processed: result.processed,
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

  deps.app.get('/channel/webhooks/validate/reaction-latest', deps.checkIp, async (_req: Request, res: Response) => {
    try {
      const capture = await deps.captureStore.getLatestByEventType('message.reaction');
      if (!capture) {
        res.status(404).json({ status: false, message: 'No capture found for eventType: message.reaction' });
        return;
      }

      const normalized = normalizeOpenwaEvent(capture.payload);
      if (!normalized || normalized.eventType !== 'message.reaction') {
        res.status(422).json({ status: false, message: 'Latest message.reaction capture could not be normalized' });
        return;
      }

      const stored = await loadTicketNotification({ remoteJid: normalized.chatId, messageId: normalized.messageId });
      res.status(200).json({
        status: true,
        capture: { captureId: capture.captureId, capturedAt: capture.capturedAt, eventType: capture.eventType },
        normalized,
        correlation: {
          lookupKey: { remoteJid: normalized.chatId, messageId: normalized.messageId },
          found: Boolean(stored),
          ticketId: stored?.ticketId ?? null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ status: false, message });
    }
  });

  deps.app.post(
    '/channel/webhooks/test',
    deps.checkIp,
    [body('payload').custom((value) => value !== undefined).withMessage('payload is required'), body('headers').optional().isObject()],
    async (req: Request, res: Response) => {
      if (hasValidationError(req, res)) return;

      try {
        const bodyValue = req.body as {
          payload: unknown;
          headers?: Record<string, unknown>;
        };

        const result = await processWebhookPayload({
          payload: bodyValue.payload,
          headers: {
            ...toHeaderRecord(req.headers),
            ...toStringRecord(bodyValue.headers),
            'x-webhook-test': 'true',
          },
          path: req.path,
          method: req.method,
          remoteAddress: req.ip ?? '',
          captureStore: deps.captureStore,
          commandService: deps.commandService,
          n8n: deps.n8n,
        });

        res.status(202).json({
          status: true,
          mode: 'test',
          captured: result.captured,
          processed: result.processed,
        });
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
