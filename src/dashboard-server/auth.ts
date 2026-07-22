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

// Token revocation blacklist — in-memory by default, Redis-backed if DASHBOARD_REDIS_URL is set.
// Entries include the token's exp claim so we can auto-purge expired entries.
const blacklist = new Map<string, number>();
let blacklistRedis: Awaited<ReturnType<typeof getRedisClient>> | null = null;

async function getRedisClient() {
  const url = process.env.DASHBOARD_REDIS_URL;
  if (!url) return null;
  try {
    const { Redis } = await import('ioredis');
    return new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true, connectTimeout: 5000 });
  } catch { return null; }
}

/** Add a token to the revocation blacklist. Stores the expiry claim for cleanup. */
export async function revokeToken(token: string): Promise<void> {
  try {
    const payload = jwt.decode(token) as { exp?: number } | null;
    if (!payload?.exp) return;
    const redis = blacklistRedis ?? (blacklistRedis = await getRedisClient());
    if (redis) {
      try { await redis.set(`arena:revoked:${token}`, '1', 'EXAT', payload.exp); } catch { /* fall through to memory */ }
      return;
    }
  } catch { /* non-fatal */ }
  try {
    const decoded = jwt.decode(token) as { exp?: number } | null;
    if (decoded?.exp) blacklist.set(token, decoded.exp);
  } catch { /* ignore */ }
}

/** Check if a token has been revoked. */
async function isRevoked(token: string): Promise<boolean> {
  const redis = blacklistRedis;
  if (redis) {
    try { return (await redis.exists(`arena:revoked:${token}`)) === 1; } catch { /* fall through */ }
  }
  const exp = blacklist.get(token);
  if (!exp) return false;
  if (Date.now() / 1000 > exp) { blacklist.delete(token); return false; }
  return true;
}

// Periodic purge of expired entries from the in-memory blacklist
setInterval(() => {
  const now = Date.now() / 1000;
  for (const [key, exp] of blacklist) { if (exp <= now) blacklist.delete(key); }
}, 300_000).unref();

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
  return null;
}

/** Express middleware: require a valid Bearer JWT. Checks revocation blacklist after verify. */
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
    // Check revocation blacklist (async, but non-blocking — if Redis is down we proceed)
    void isRevoked(token).then(revoked => {
      if (revoked) {
        res.status(401).json({ error: 'Token has been revoked' });
      } else {
        req.user = verified;
        next();
      }
    }).catch(() => {
      // Redis error — proceed without revocation check
      req.user = verified;
      next();
    });
  };
}
