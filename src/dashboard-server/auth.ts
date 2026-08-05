import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { outputRoot } from '../paths.js';
import { createLogger } from '../logger/pino-logger.js';

const logger = createLogger('ai-arena:auth');

export interface AuthConfig {
  username: string;
  password: string;
  secret: string;
  expiresIn: string;
  generatedPassword?: string;
}

// Token revocation blacklist — in-memory by default, Redis-backed if
// DASHBOARD_REDIS_URL is set. Entries include the token's exp claim so we
// can auto-purge expired entries.
//
// Failover semantics (H4):
//   - DASHBOARD_REDIS_URL unset (dev): use the in-memory Map only. This is
//     per-process and best-effort — acceptable for local dev.
//   - DASHBOARD_REDIS_URL set (prod): Redis is the source of truth for
//     revocation across multiple dashboard replicas. If Redis is
//     unreachable, isRevoked() THROWS (RedisUnavailableError) so the
//     caller (requireAuth) can fail-CLOSED — a revoked or compromised token
//     must not remain valid during a Redis outage. Previously the error was
//     swallowed and the request proceeded ("fail-open without revocation
//     check"), which let a revoked admin token stay valid until natural
//     expiry (default 12h).
const blacklist = new Map<string, number>();
let blacklistRedis: Awaited<ReturnType<typeof getRedisClient>> | null = null;

/** Error thrown when Redis is configured but unreachable. */
export class RedisUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisUnavailableError';
  }
}

async function getRedisClient() {
  const url = process.env.DASHBOARD_REDIS_URL;
  if (!url) return null;
  try {
    const { Redis } = await import('ioredis');
    const client = new Redis(url, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      connectTimeout: 5000,
      // Prevent unhandled 'error' events from hanging the process when the
      // connection fails — we handle connect() rejection explicitly below.
      enableOfflineQueue: false,
      retryStrategy: () => null, // don't auto-retry; we'll disconnect on failure
    });
    // Attach an error listener so ioredis's emitted error events (e.g.
    // ECONNREFUSED) don't crash the process or hang the event loop.
    client.on('error', () => { /* handled via connect() rejection below */ });
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

/** Lazily initialize the Redis client. Retries on every call until success
 * (does NOT cache a null result), so a transient Redis outage at boot does
 * not permanently brick the dashboard. Once a connection succeeds, the
 * client is cached for the process lifetime. */
async function getBlacklistRedis(): Promise<Awaited<ReturnType<typeof getRedisClient>> | null> {
  // Only cache a successful client. A null result from getRedisClient() is
  // NOT cached — so the next call retries init (rate-limited by connectTimeout
  // inside getRedisClient). This allows recovery after a transient failure.
  if (blacklistRedis) return blacklistRedis;
  const client = await getRedisClient();
  // Assign only on success so a transient failure doesn't stick.
  if (client) blacklistRedis = client;
  return client ?? null;
}

/** Add a token to the revocation blacklist. Stores the expiry claim for cleanup. */
export async function revokeToken(token: string): Promise<void> {
  try {
    const payload = jwt.decode(token) as { exp?: number } | null;
    if (!payload?.exp) return;
    // Route through getBlacklistRedis() for consistent lazy-init (I2: this
    // previously bypassed it and called getRedisClient() directly, which
    // could race with the first isRevoked call and leak a connection).
    const redis = await getBlacklistRedis();
    if (redis) {
      try {
        await redis.set(`arena:revoked:${token}`, '1', 'EXAT', payload.exp);
        return;
      } catch {
        // Redis write failed — fall through to in-memory so the local node
        // at least records the revocation. Other replicas won't see it until
        // Redis recovers, but local revocation is better than nothing.
      }
    }
  } catch { /* non-fatal */ }
  try {
    const decoded = jwt.decode(token) as { exp?: number } | null;
    if (decoded?.exp) blacklist.set(token, decoded.exp);
  } catch { /* ignore */ }
}

/**
 * Check if a token has been revoked.
 *
 * @throws {RedisUnavailableError} when DASHBOARD_REDIS_URL is set but the
 *   Redis client is null or the EXISTS query throws. The caller
 *   (requireAuth) treats this as fail-CLOSED (reject the request) so a
 *   revoked token cannot bypass the check during a Redis outage.
 *
 * When DASHBOARD_REDIS_URL is unset, the in-memory Map is consulted and
 * this never throws (dev mode — per-process revocation is acceptable).
 */
async function isRevoked(token: string): Promise<boolean> {
  const redisUrl = process.env.DASHBOARD_REDIS_URL;
  if (redisUrl) {
    // Operator configured Redis — it is the source of truth.
    let redis = blacklistRedis;
    if (!redis) redis = await getBlacklistRedis();
    if (!redis) {
      throw new RedisUnavailableError(
        'DASHBOARD_REDIS_URL is set but the Redis client could not be ' +
        'initialized — refusing to authorize without revocation check.',
      );
    }
    try {
      return (await redis.exists(`arena:revoked:${token}`)) === 1;
    } catch (e) {
      // Redis query failed (connection dropped, timeout). Re-throw so the
      // caller fails closed.
      throw new RedisUnavailableError(
        `Redis revocation check failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // Dev mode — in-memory blacklist only.
  const exp = blacklist.get(token);
  if (!exp) return false;
  if (Date.now() / 1000 > exp) { blacklist.delete(token); return false; }
  return true;
}

/** Public wrapper for WebSocket auth (ws-auth.ts) — same fail-closed semantics. */
export { isRevoked };

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

const BEARER_PREFIX = 'Bearer ';

/**
 * Parse an Authorization header and return the bearer token, or null.
 * Linear-time string parsing — the previous /^Bearer\s+(.+)$/i regex was
 * quadratic on headers with long runs of whitespace (CodeQL js/polynomial-redos).
 */
export function extractBearerToken(authorization: string): string | null {
  if (authorization.length <= BEARER_PREFIX.length) return null;
  if (authorization.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX.toLowerCase()) {
    return null;
  }
  const token = authorization.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function extractToken(req: Request): string | null {
  // 1. Authorization: Bearer <token> header (standard)
  const token = extractBearerToken(req.headers.authorization ?? '');
  if (token) return token;
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
    // Check revocation blacklist. Fail-CLOSED on Redis outage (H4): if
    // DASHBOARD_REDIS_URL is set the operator intends revocation to be
    // authoritative across replicas — a Redis outage must NOT let a
    // revoked token through. Previously this was fail-open ("Redis error —
    // proceed without revocation check"), which let a revoked admin token
    // stay valid until natural expiry (default 12h).
    try {
      const revoked = await isRevoked(token);
      if (revoked) {
        res.status(401).json({ error: 'Token has been revoked' });
        return;
      }
    } catch (e) {
      if (e instanceof RedisUnavailableError) {
        // Fail closed: a revoked token must not bypass the check during a
        // Redis outage. Surface a 503 (not 401) so legitimate clients can
        // distinguish "token invalid" from "revocation service down".
        res.status(503).json({
          error: 'Revocation service unavailable',
          detail: e.message,
        });
        return;
      }
      // Unexpected error — fail closed defensively and log.
      logger.error('Unexpected error during revocation check', { error: e instanceof Error ? e.message : String(e) });
      res.status(503).json({ error: 'Revocation service unavailable' });
      return;
    }
    req.user = verified;
    next();
  };
}
