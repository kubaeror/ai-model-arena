import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../../src/tools/web.js';
import type { ToolExecutionContext } from '../../src/types.js';

// H6: SSRF hardening — expanded private-IP / metadata-hostname / internal-DNS
// blocklist, userinfo rejection, and DNS-resolution pinning. These tests
// cover the pure validation surface (validateUrl + isPrivateHost) via the
// webFetch tool executor, which surfaces validation errors as isError content.

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as ToolExecutionContext['logger'];

function makeCtx(webAccess = true): ToolExecutionContext {
  return {
    sandboxDir: '/tmp/arena-web-test',
    logger,
    shellTimeoutMs: 30000,
    maxShellOutputBytes: 524288,
    webAccess,
  };
}

async function fetchRejection(url: string): Promise<string> {
  const r = await webFetch({ url }, makeCtx());
  assert.equal(r.isError, true, `expected ${url} to be rejected`);
  return r.content;
}

test('rejects loopback 127.0.0.1', async () => {
  const c = await fetchRejection('http://127.0.0.1/secret');
  assert.match(c, /private|blocked/i);
});

test('rejects 169.254.169.254 (AWS IMDS / GCP metadata)', async () => {
  const c = await fetchRejection('http://169.254.169.254/latest/meta-data/');
  assert.match(c, /private|blocked/i);
});

test('rejects 169.254.169.253 (Azure metadata)', async () => {
  const c = await fetchRejection('http://169.254.169.253/metadata/instance');
  assert.match(c, /private|blocked/i);
});

test('rejects metadata.google.internal (GCP)', async () => {
  const c = await fetchRejection('http://metadata.google.internal/computeMetadata/');
  assert.match(c, /private|blocked/i);
});

test('rejects metadata.azure.com (Azure)', async () => {
  const c = await fetchRejection('http://metadata.azure.com/metadata');
  assert.match(c, /private|blocked/i);
});

test('rejects CGNAT 100.64.0.1', async () => {
  const c = await fetchRejection('http://100.64.0.1/');
  assert.match(c, /private|blocked/i);
});

test('rejects 10.x private range', async () => {
  const c = await fetchRejection('http://10.0.0.1/');
  assert.match(c, /private|blocked/i);
});

test('rejects 172.16.x private range', async () => {
  const c = await fetchRejection('http://172.16.0.1/');
  assert.match(c, /private|blocked/i);
});

test('rejects 192.168.x private range', async () => {
  const c = await fetchRejection('http://192.168.1.1/');
  assert.match(c, /private|blocked/i);
});

test('rejects 0.0.0.0', async () => {
  const c = await fetchRejection('http://0.0.0.0/');
  assert.match(c, /private|blocked/i);
});

test('rejects IPv6 loopback ::1', async () => {
  const c = await fetchRejection('http://[::1]/');
  assert.match(c, /private|blocked/i);
});

test('rejects IPv6 unique-local fd00::', async () => {
  const c = await fetchRejection('http://[fd00::1]/');
  assert.match(c, /private|blocked/i);
});

test('rejects .local mDNS hostnames', async () => {
  const c = await fetchRejection('http://evil.local/');
  assert.match(c, /private|blocked/i);
});

test('rejects .internal hostnames', async () => {
  const c = await fetchRejection('http://evil.internal/');
  assert.match(c, /private|blocked/i);
});

test('rejects .svc.cluster.local in-cluster service names', async () => {
  const c = await fetchRejection('http://dashboard.svc.cluster.local/');
  assert.match(c, /private|blocked/i);
});

test('rejects URLs with userinfo (credentials)', async () => {
  // SSRF bypass: credentials in URL can be used to confuse parsers.
  const c = await fetchRejection('http://user:pass@example.com/');
  assert.match(c, /credentials|userinfo/i);
});

test('rejects non-http(s) protocols (gopher)', async () => {
  const c = await fetchRejection('gopher://example.com/');
  assert.match(c, /Unsupported protocol/i);
});

test('rejects file: protocol', async () => {
  const c = await fetchRejection('file:///etc/passwd');
  assert.match(c, /Unsupported protocol/i);
});

// Note: DNS-rebinding pinning (resolveAndValidateHost + IP-literal fetch) and
// manual redirect re-validation are integration-tested against a live HTTP
// server in tests/tools/web.test.ts; the pure validation surface above covers
// the expanded blocklist which is the primary regression target.
