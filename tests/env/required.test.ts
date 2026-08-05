import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRequiredEnv, missingRequiredEnv } from '../../src/env/required.js';

const REQUIRED_KEYS = [
  'ARENA_SKIP_ENV_CHECK',
  'DB_DRIVER',
  'QUEUE_DRIVER',
  'OUTPUT_ROOT',
  'DATABASE_URL',
  'REDIS_URL',
  'DASHBOARD_JWT_SECRET',
  'DASHBOARD_PASSWORD',
] as const;

function clearEnv(t: import('node:test').TestContext): void {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  for (const key of REQUIRED_KEYS) delete process.env[key];
}

test('runner with all vars unset lists DB_DRIVER', (t) => {
  clearEnv(t);

  const missing = missingRequiredEnv('runner');
  assert.ok(missing.includes('DB_DRIVER'), `expected DB_DRIVER in missing list, got: ${missing.join(', ')}`);
  assert.ok(missing.includes('QUEUE_DRIVER'));
  assert.ok(missing.includes('OUTPUT_ROOT'));

  assert.throws(
    () => assertRequiredEnv('runner'),
    /DB_DRIVER/,
    'assertRequiredEnv should throw listing the missing vars',
  );
});

test('postgres driver without DATABASE_URL lists it', (t) => {
  clearEnv(t);
  process.env.DB_DRIVER = 'postgres';

  const missing = missingRequiredEnv('runner');
  assert.ok(missing.includes('DATABASE_URL'));
  assert.ok(!missing.includes('DB_DRIVER'), 'DB_DRIVER is set, must not be listed');

  assert.throws(() => assertRequiredEnv('runner'), /DATABASE_URL/);
});

test('redis queue driver without REDIS_URL lists it', (t) => {
  clearEnv(t);
  process.env.QUEUE_DRIVER = 'redis';

  const missing = missingRequiredEnv('runner');
  assert.ok(missing.includes('REDIS_URL'));

  assert.throws(() => assertRequiredEnv('runner'), /REDIS_URL/);
});

test('dashboard with vars unset lists DASHBOARD_JWT_SECRET (not DASHBOARD_PASSWORD)', (t) => {
  clearEnv(t);

  const missing = missingRequiredEnv('dashboard');
  assert.ok(missing.includes('DASHBOARD_JWT_SECRET'), `expected DASHBOARD_JWT_SECRET, got: ${missing.join(', ')}`);
  assert.ok(missing.includes('DB_DRIVER'));
  assert.ok(!missing.includes('DASHBOARD_PASSWORD'), 'dev generates a one-time password — must not be required');

  assert.throws(() => assertRequiredEnv('dashboard'), /DASHBOARD_JWT_SECRET/);
});

test('no missing vars → assertRequiredEnv returns [] and does not throw', (t) => {
  clearEnv(t);
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OUTPUT_ROOT = '/tmp/arena-outputs';
  process.env.DASHBOARD_JWT_SECRET = 'test-secret';

  assert.deepEqual(assertRequiredEnv('runner'), []);
  assert.deepEqual(assertRequiredEnv('dashboard'), []);
});

test('ARENA_SKIP_ENV_CHECK=1 returns [] even with all vars unset', (t) => {
  clearEnv(t);
  process.env.ARENA_SKIP_ENV_CHECK = '1';

  assert.deepEqual(assertRequiredEnv('runner'), []);
  assert.deepEqual(assertRequiredEnv('dashboard'), []);
});

test('optional vars never throw', (t) => {
  clearEnv(t);
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OUTPUT_ROOT = '/tmp/arena-outputs';
  process.env.DASHBOARD_JWT_SECRET = 'test-secret';
  process.env.DASHBOARD_JWT_EXPIRES_IN = '1h';

  assert.deepEqual(assertRequiredEnv('runner'), []);
  assert.deepEqual(assertRequiredEnv('dashboard'), []);
});
