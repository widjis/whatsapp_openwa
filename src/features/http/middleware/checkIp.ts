import type { NextFunction, Request, Response } from 'express';

function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? (ip.split('::ffff:')[1] ?? ip) : ip;
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

export function createCheckIpMiddleware(allowedIps: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const clientIp = getClientIp(req);
    if (allowedIps.includes(clientIp)) {
      next();
      return;
    }

    res.status(403).json({ status: false, message: 'Forbidden' });
  };
}
