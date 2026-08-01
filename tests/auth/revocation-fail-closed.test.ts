import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { requireAuth, signToken, loadAuthConfig, RedisUnavailableError } from '../../src/dashboard-server/auth.js';

// H4: requireAuth must fail-CLOSED when DASHBOARD_REDIS_URL is set but Redis
// is unreachable. Previously it fail-OPENED ("Redis error — proceed without
// revocation check"), letting a revoked admin token stay valid until natural
// expiry (default 12h).

const testSecret = crypto.randomBytes(32).toString('hex');

beforeEach(() => {
  process.env.DASHBOARD_USERNAME = 'testuser';
  process.env.DASHBOARD_PASSWORD = 'testpass';
  process.env.DASHBOARD_JWT_SECRET = testSecret;
  // No DASHBOARD_REDIS_URL — dev mode (in-memory blacklist).
  delete process.env.DASHBOARD_REDIS_URL;
});

afterEach(() => {
  delete process.env.DASHBOARD_REDIS_URL;
});

function mockReq(token: string | null): unknown {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return { headers, cookies: {} };
}

function runAuth(token: string | null): { statusCode: number; body: unknown; calledNext: boolean } {
  const state = { statusCode: 0, body: undefined as unknown, calledNext: false };
  const req = mockReq(token);
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(body: unknown) { state.body = body; return this; },
  };
  const cfg = loadAuthConfig();
  const middleware = requireAuth(cfg);
  // requireAuth returns an async middleware — call and handle the promise.
  middleware(req as never, res as never, (() => { state.calledNext = true; }) as never);
  return { statusCode: state.statusCode, body: state.body, calledNext: state.calledNext };
}

async function runAuthAsync(token: string | null): Promise<{ statusCode: number; body: unknown; calledNext: boolean }> {
  const state = { statusCode: 0, body: undefined as unknown, calledNext: false };
  const req = mockReq(token);
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(body: unknown) { state.body = body; return this; },
  };
  const cfg = loadAuthConfig();
  const middleware = requireAuth(cfg);
  await middleware(req as never, res as never, (() => { state.calledNext = true; }) as never);
  return { statusCode: state.statusCode, body: state.body, calledNext: state.calledNext };
}

test('requireAuth rejects missing token with 401', async () => {
  const r = await runAuthAsync(null);
  assert.equal(r.calledNext, false);
  assert.equal(r.statusCode, 401);
});

test('requireAuth accepts a valid token in dev mode (no Redis)', async () => {
  const cfg = loadAuthConfig();
  const token = signToken(cfg, 'alice', 'viewer');
  const r = await runAuthAsync(token);
  assert.equal(r.calledNext, true);
  assert.equal(r.statusCode, 0);
});

test('requireAuth rejects an invalid token with 401', async () => {
  const r = await runAuthAsync('not-a-real-token');
  assert.equal(r.calledNext, false);
  assert.equal(r.statusCode, 401);
});

test('RedisUnavailableError is exported and constructible', () => {
  const err = new RedisUnavailableError('redis down');
  assert.equal(err.name, 'RedisUnavailableError');
  assert.equal(err.message, 'redis down');
  assert.ok(err instanceof Error);
});

test('requireAuth fails CLOSED (503) when Redis is configured but unreachable', async () => {
  // Set DASHBOARD_REDIS_URL to a port where nothing listens. The Redis
  // client connect will time out / fail, so getRedisClient() returns null,
  // and isRevoked() throws RedisUnavailableError. requireAuth must reject
  // with 503, NOT proceed (fail-open).
  process.env.DASHBOARD_REDIS_URL = 'redis://127.0.0.1:1/0'; // port 1 = unreachable
  const cfg = loadAuthConfig();
  const token = signToken(cfg, 'alice', 'admin');
  const r = await runAuthAsync(token);
  assert.equal(r.calledNext, false);
  assert.equal(r.statusCode, 503);
  const body = r.body as { error: string };
  assert.match(body.error, /Revocation service unavailable/i);
});

test('requireAuth still accepts valid tokens when Redis is unconfigured (dev)', async () => {
  // DASHBOARD_REDIS_URL unset — dev mode, in-memory blacklist only.
  delete process.env.DASHBOARD_REDIS_URL;
  const cfg = loadAuthConfig();
  const token = signToken(cfg, 'bob', 'viewer');
  const r = await runAuthAsync(token);
  assert.equal(r.calledNext, true);
  assert.equal(r.statusCode, 0);
});
