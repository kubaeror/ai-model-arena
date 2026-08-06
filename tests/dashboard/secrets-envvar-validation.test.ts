import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './route-test-harness.js';
import { isValidEnvVarName, hasControlChars } from '../../src/dashboard-server/routes/secrets.js';

async function putJson(base: string, token: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

test('isValidEnvVarName accepts normal env var keys', () => {
  assert.equal(isValidEnvVarName('OPENAI_API_KEY'), true);
  assert.equal(isValidEnvVarName('MY-API-KEY'), true); // k8s-style keys stay settable
  assert.equal(isValidEnvVarName('MY.KEY'), true);     // store-level regex-special keys remain legal
});

test('isValidEnvVarName rejects keys that break .env parsing', () => {
  assert.equal(isValidEnvVarName(''), false);
  assert.equal(isValidEnvVarName('A B'), false);
  assert.equal(isValidEnvVarName('A\nB'), false);
  assert.equal(isValidEnvVarName('A\rB'), false);
  assert.equal(isValidEnvVarName('A\tB'), false);
  assert.equal(isValidEnvVarName('A=B'), false);
  assert.equal(isValidEnvVarName('A/B'), false);   // not k8s-secret-key compatible
  assert.equal(isValidEnvVarName('A:B'), false);   // not k8s-secret-key compatible
});

test('isValidEnvVarName rejects Object.prototype key names (prototype-pollution guard)', () => {
  assert.equal(isValidEnvVarName('__proto__'), false);
  assert.equal(isValidEnvVarName('constructor'), false);
  assert.equal(isValidEnvVarName('prototype'), false);
});

test('hasControlChars rejects newline-containing values', () => {
  assert.equal(hasControlChars('sk-abc123'), false);
  assert.equal(hasControlChars('line1\nline2'), true);
  assert.equal(hasControlChars('line1\r\nline2'), true);
});

test('PUT /api/secrets/:envVar rejects an envVar with a newline (env line injection)', async (t) => {
  const h = await boot(t);
  const res = await putJson(
    h.base,
    h.adminToken,
    `/api/secrets/${encodeURIComponent('FOO\nBAR=x')}`,
    { value: 'v' },
  );
  assert.equal(res.status, 400, 'newline in envVar must be rejected');
});

test('PUT /api/secrets/:envVar rejects an envVar with an equals sign', async (t) => {
  const h = await boot(t);
  const res = await putJson(h.base, h.adminToken, '/api/secrets/A%3DB', { value: 'v' });
  assert.equal(res.status, 400, 'equals sign in envVar must be rejected');
});

test('PUT /api/secrets/:envVar rejects a value containing newlines', async (t) => {
  const h = await boot(t);
  const res = await putJson(h.base, h.adminToken, '/api/secrets/SAFE_KEY', {
    value: 'line1\nEVIL=1',
  });
  assert.equal(res.status, 400, 'newline in secret value must be rejected');
});
