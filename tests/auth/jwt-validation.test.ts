import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { verifyToken, signToken, loadAuthConfig } from '../../src/dashboard-server/auth.js';

const testSecret = crypto.randomBytes(32).toString('hex');
delete process.env.DASHBOARD_JWT_SECRET;

// Set env vars needed by loadAuthConfig
process.env.DASHBOARD_USERNAME = 'testuser';
process.env.DASHBOARD_PASSWORD = 'testpass';
process.env.DASHBOARD_JWT_SECRET = testSecret;

test('signToken → verifyToken round-trips role', () => {
  const cfg = loadAuthConfig();
  const token = signToken(cfg, 'testuser', 'editor');
  const decoded = verifyToken(cfg, token);
  assert.ok(decoded);
  assert.equal(decoded!.sub, 'testuser');
  assert.equal(decoded!.role, 'editor');
});

test('verifyToken returns null for malformed token', () => {
  const cfg = loadAuthConfig();
  assert.equal(verifyToken(cfg, 'not-a-token'), null);
});

test('verifyToken returns null for token with wrong secret', () => {
  const cfg = loadAuthConfig();
  const token = jwt.sign({ sub: 'user', role: 'admin' }, 'wrong-secret', { expiresIn: '1h' });
  assert.equal(verifyToken(cfg, token), null);
});

test('verifyToken returns null for expired token', async () => {
  const cfg = loadAuthConfig();
  const token = jwt.sign({ sub: 'user', role: 'viewer' }, testSecret, { expiresIn: '0s' });
  // Small delay to ensure expiration
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(verifyToken(cfg, token), null);
});

test('loadAuthConfig throws without JWT_SECRET', () => {
  delete process.env.DASHBOARD_JWT_SECRET;
  assert.throws(() => loadAuthConfig(), /DASHBOARD_JWT_SECRET/);
  process.env.DASHBOARD_JWT_SECRET = testSecret;
});

test('loadAuthConfig hard-fails in production when DASHBOARD_PASSWORD unset', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevPassword = process.env.DASHBOARD_PASSWORD;
  process.env.NODE_ENV = 'production';
  delete process.env.DASHBOARD_PASSWORD;
  try {
    assert.throws(() => loadAuthConfig(), /DASHBOARD_PASSWORD/);
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
    if (prevPassword !== undefined) process.env.DASHBOARD_PASSWORD = prevPassword;
    else delete process.env.DASHBOARD_PASSWORD;
  }
});

test('signToken default role is admin', () => {
  const cfg = loadAuthConfig();
  const token = signToken(cfg, 'testuser');
  const decoded = verifyToken(cfg, token);
  assert.equal(decoded!.role, 'admin');
});

test('verifyToken rejects a token signed with a different algorithm (HS384)', () => {
  const cfg = loadAuthConfig();
  // Sign with HS384 instead of HS256 — verifyToken pins algorithms to HS256.
  const token = jwt.sign({ sub: 'user', role: 'admin' }, testSecret, { algorithm: 'HS384', expiresIn: '1h' });
  assert.equal(verifyToken(cfg, token), null);
});

test('verifyToken rejects a token signed with a different algorithm (HS512)', () => {
  const cfg = loadAuthConfig();
  const token = jwt.sign({ sub: 'user', role: 'admin' }, testSecret, { algorithm: 'HS512', expiresIn: '1h' });
  assert.equal(verifyToken(cfg, token), null);
});
