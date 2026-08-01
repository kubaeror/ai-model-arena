import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { outputRoot } from '../paths.js';

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
 * Credentials live in env vars (DASHBOARD_USERNAME / DASHBOARD_PASSWORD). If
 * no password is configured:
 *   - In production (NODE_ENV=production) the boot HARD-FAILS. Container log
 *     aggregators capture stderr, so printing a generated password to stderr
 *     (the previous behavior) leaked admin credentials into logs — the code
 *     comment claiming "NOT written to logs" was factually wrong. Operators
 *     must set DASHBOARD_PASSWORD explicitly in production (the k8s manifest
 *     already loads it from the `dashboard-auth` secret).
 *   - In dev we generate a one-time password and write it to a root-owned,
 *     mode-0600 file at <OUTPUT_ROOT>/.admin-password, printing only the file
 *     path. The dashboard is never exposed unauthenticated.
 */
export function loadAuthConfig(): AuthConfig {
  const username = process.env.DASHBOARD_USERNAME ?? 'admin';
  let password = process.env.DASHBOARD_PASSWORD ?? '';
  let generatedPassword: string | undefined;
  if (!password) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'DASHBOARD_PASSWORD is not set and NODE_ENV=production.\n' +
        'Refusing to boot: generating a random admin password in production is ' +
        'unsafe (the password had to be surfaced somewhere observable, e.g. ' +
        'stderr/logs, which defeats the purpose). Set DASHBOARD_PASSWORD ' +
        'explicitly — in k8s it is loaded from the `dashboard-auth` secret.',
      );
    }
    password = crypto.randomBytes(12).toString('base64url');
    generatedPassword = password;
    writeGeneratedPasswordFile(password);
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

/**
 * Write a generated one-time admin password to a root-owned, mode-0600 file
 * under OUTPUT_ROOT so the operator can retrieve it from the filesystem
 * without it landing in aggregated container logs. Returns the file path.
 * Failures are non-fatal (best-effort) — the password is still valid
 * in-memory and the operator can set DASHBOARD_PASSWORD explicitly next time.
 */
function writeGeneratedPasswordFile(password: string): void {
  try {
    const dir = outputRoot();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, '.admin-password');
    // Write with explicit mode 0o600 (owner read/write only). On Windows the
    // mode is ignored but the file is still written.
    const fd = fs.openSync(filePath, 'w', 0o600);
    fs.writeFileSync(fd, `admin:${password}\n`);
    fs.closeSync(fd);
    // Re-assert 0o600 in case the file pre-existed with looser perms.
    try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
    console.error(
      `[ai-arena] No DASHBOARD_PASSWORD set — generated a one-time admin password.\n` +
      `[ai-arena] It has been written to: ${filePath}\n` +
      `[ai-arena] Read it there, then set DASHBOARD_PASSWORD explicitly next time.\n` +
      `[ai-arena] (This message is safe to log — it does not contain the password.)\n`,
    );
  } catch {
    // Could not write the file (read-only fs, permissions, etc.). The password
    // is still valid in-memory for this process's lifetime; the operator must
    // set DASHBOARD_PASSWORD explicitly to recover it.
    console.error(
      '[ai-arena] No DASHBOARD_PASSWORD set and unable to write the generated ' +
      'password file. Set DASHBOARD_PASSWORD explicitly to log in.\n',
    );
  }
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
    // Pin the accepted algorithms to HS256. Without this, jwt.verify accepts
    // HS256/HS384/HS512 — a defense-in-depth gap that could enable
    // algorithm-confusion attacks (e.g. a token signed with a public key
    // used as the HMAC secret) if a future library upgrade or key-type
    // change silently broadens the accepted set. signToken() always emits
    // HS256, so pinning verify to HS256 is the strict match.
    const payload = jwt.verify(token, cfg.secret, { algorithms: ['HS256'] }) as { sub?: string; role?: string };
    return { sub: payload.sub ?? 'unknown', role: payload.role ?? 'viewer' };
  } catch {
    return null;
  }
}

export interface AuthedRequest extends Request {
  user?: { sub: string; role: string };
  correlationId?: string;
  clientIp?: string;
}

const COOKIE_BASE = 'arena_token';
function cookieName(): string {
  return process.env.NODE_ENV === 'production' ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;
}

function extractToken(req: Request): string | null {
  // 1. Authorization: Bearer <token> header (standard)
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m?.[1]) return m[1];
  // 2. httpOnly cookie (production — XSS-resistant)
  const cookies = req.headers.cookie ?? '';
  // Try __Host- prefixed first, then plain
  for (const name of [cookieName(), COOKIE_BASE]) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cm = new RegExp('(?:^|;\\s*)' + escaped + '=([^;]+)').exec(cookies);
    if (cm?.[1]) return cm[1];
  }
  return null;
}

/** Set the JWT as an httpOnly, SameSite=strict cookie. Uses __Host- prefix in production. */
export function setTokenCookie(res: Response, token: string, cfg: AuthConfig): void {
  const maxAge = parseExpiresInToSeconds(cfg.expiresIn);
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(cookieName(), token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    maxAge: maxAge * 1000,
    path: '/',
  });
}

/** Clear the auth cookie (clears both prefixed and plain variants). */
export function clearTokenCookie(res: Response): void {
  const opts = { path: '/' };
  res.clearCookie(cookieName(), opts);
  res.clearCookie(COOKIE_BASE, opts);
}

function parseExpiresInToSeconds(expiresIn: string): number {
  const m = /^(\d+)([hmsd])$/.exec(expiresIn);
  if (!m) return 43200; // default 12h
  const num = parseInt(m[1]!, 10);
  switch (m[2]) {
    case 's': return num;
    case 'm': return num * 60;
    case 'h': return num * 3600;
    case 'd': return num * 86400;
    default: return 43200;
  }
}

/** Express middleware: require a valid Bearer JWT. Checks revocation blacklist after verify. */
export function requireAuth(cfg: AuthConfig) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
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
    // Check revocation blacklist — if Redis is down, fail-open without revocation check
    try {
      const revoked = await isRevoked(token);
      if (revoked) {
        res.status(401).json({ error: 'Token has been revoked' });
        return;
      }
    } catch {
      // Redis error — proceed without revocation check
    }
    req.user = verified;
    next();
  };
}
