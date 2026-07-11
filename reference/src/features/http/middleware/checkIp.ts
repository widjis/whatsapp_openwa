import type { NextFunction, Request, Response } from 'express';
import type { WASocket } from '@whiskeysockets/baileys';

export type SendAlertArgs = {
  clientIp: string;
  path: string;
};

export type CheckIpDeps = {
  allowedIps: string[];
  getSocket: () => WASocket | undefined;
  alertReceiverJid: string;
};

function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) {
    return ip.split('::ffff:')[1] ?? ip;
  }
  return ip;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw =
    typeof forwarded === 'string'
      ? forwarded
      : Array.isArray(forwarded)
        ? forwarded.join(',')
        : req.ip ?? '';

  const first = raw.split(',')[0]?.trim();
  return normalizeIp(first || raw || '');
}

async function sendAlertMessage(args: SendAlertArgs & { deps: CheckIpDeps }): Promise<void> {
  console.log(`Unauthorized access attempt detected from IP: ${args.clientIp} to endpoint: ${args.path}`);
  const sock = args.deps.getSocket();
  if (!sock) return;

  try {
    await sock.sendMessage(args.deps.alertReceiverJid, {
      text: `🚨 Unauthorized access attempt from IP: ${args.clientIp} to endpoint: ${args.path}`,
    });
  } catch (error) {
    console.error('Failed to send WhatsApp alert:', error);
  }
}

export function createCheckIpMiddleware(deps: CheckIpDeps) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const clientIp = getClientIp(req);
    console.log('Request IP:', req.headers['x-forwarded-for'] ?? req.ip);
    console.log('Client IP:', clientIp);

    if (deps.allowedIps.includes(clientIp)) {
      next();
      return;
    }

    console.log('Forbidden IP:', clientIp);
    await sendAlertMessage({ clientIp, path: req.path, deps });
    res.status(403).json({ message: 'Forbidden' });
  };
}
