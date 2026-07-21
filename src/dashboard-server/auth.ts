import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

export interface AuthConfig {
  username: string;
  password: string;
  secret: string;
  expiresIn: string;
  generatedPassword?: string;
}

/**
 * Credentials live in env vars (DASHBOARD_USERNAME / DASHBOARD_PASSWORD). If no
 * password is configured we generate a one-time password and log it, so the
 * dashboard is never exposed unauthenticated — even in local/dev use.
 */
export function loadAuthConfig(): AuthConfig {
  const username = process.env.DASHBOARD_USERNAME ?? 'admin';
  let password = process.env.DASHBOARD_PASSWORD ?? '';
  let generatedPassword: string | undefined;
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url');
    generatedPassword = password;
  }
  const secret = process.env.DASHBOARD_JWT_SECRET ?? '';
  if (!secret) {
    throw new Error(
      'DASHBOARD_JWT_SECRET is not set.\n' +
      'Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
      'Then add DASHBOARD_JWT_SECRET=<value> to your .env file.',
    );
  }
  return { username, password, secret, expiresIn: process.env.DASHBOARD_JWT_EXPIRES_IN ?? '12h', generatedPassword };
}

function timingSafeEqual(a: string, b: string): boolean {
  // Hash both inputs to a fixed-length digest so comparison time is
  // independent of input length and content.
  const key = Buffer.alloc(32, 0);
  const ha = crypto.createHmac('sha256', key).update(a).digest();
  const hb = crypto.createHmac('sha256', key).update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function verifyCredentials(cfg: AuthConfig, username: string, password: string): boolean {
  return timingSafeEqual(username, cfg.username) && timingSafeEqual(password, cfg.password);
}

export function signToken(cfg: AuthConfig, username: string, role = 'admin'): string {
  return jwt.sign({ sub: username, role }, cfg.secret, { expiresIn: cfg.expiresIn as jwt.SignOptions['expiresIn'] });
}

export function verifyToken(cfg: AuthConfig, token: string): { sub: string; role: string } | null {
  try {
    const payload = jwt.verify(token, cfg.secret) as { sub?: string; role?: string };
    return { sub: payload.sub ?? 'unknown', role: payload.role ?? 'viewer' };
  } catch {
    return null;
  }
}

export interface AuthedRequest extends Request {
  user?: { sub: string; role: string };
  correlationId?: string;
}

function extractToken(req: Request): string | null {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m?.[1]) return m[1];
  if (typeof req.query.token === 'string') return req.query.token;
  return null;
}

/** Express middleware: require a valid Bearer JWT (or ?token= for WebSocket-friendly use). */
export function requireAuth(cfg: AuthConfig) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const verified = verifyToken(cfg, token);
    if (!verified) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    req.user = verified;
    next();
  };
}
