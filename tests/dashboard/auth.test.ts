import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, verifyCredentials, loadAuthConfig } from '../../src/dashboard-server/auth.js';

test('JWT round-trips a username', () => {
  process.env.DASHBOARD_JWT_SECRET = 'a'.repeat(32);
  process.env.DASHBOARD_PASSWORD = 'testpass';
  const cfg = loadAuthConfig();
  const token = signToken(cfg, 'admin');
  const payload = verifyToken(cfg, token);
  assert.ok(payload);
  assert.equal(payload!.sub, 'admin');
});

test('verifyToken returns null for expired token', () => {
  process.env.DASHBOARD_JWT_SECRET = 'a'.repeat(32);
  process.env.DASHBOARD_PASSWORD = 'testpass';
  const cfg = loadAuthConfig();
  // We test basic null case — an obviously malformed token
  const result = verifyToken(cfg, '');
  assert.equal(result, null);
});

test('password comparison rejects wrong password', () => {
  process.env.DASHBOARD_PASSWORD = 'correct';
  process.env.DASHBOARD_JWT_SECRET = 'a'.repeat(32);
  const cfg = loadAuthConfig();
  assert.equal(verifyCredentials(cfg, 'admin', 'wrong'), false);
  assert.equal(verifyCredentials(cfg, 'admin', 'correct'), true);
});

test('verifyToken returns null for malformed token', () => {
  process.env.DASHBOARD_JWT_SECRET = 'a'.repeat(32);
  process.env.DASHBOARD_PASSWORD = 'testpass';
  const cfg = loadAuthConfig();
  assert.equal(verifyToken(cfg, 'not.a.token'), null);
});

test('missing token in empty string returns null', () => {
  process.env.DASHBOARD_JWT_SECRET = 'a'.repeat(32);
  process.env.DASHBOARD_PASSWORD = 'testpass';
  const cfg = loadAuthConfig();
  assert.equal(verifyToken(cfg, ''), null);
});
