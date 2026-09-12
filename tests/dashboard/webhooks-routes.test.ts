import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { promises as dnsPromises } from 'node:dns';
import { initDb, closeDb } from '../../src/db/client.js';
import { createWebhooksRouter } from '../../src/dashboard-server/routes/webhooks.js';

function stubDns(addresses: Array<{ address: string; family: number }>): () => void {
  const original = dnsPromises.lookup;
  (dnsPromises as { lookup: unknown }).lookup = async () => addresses;
  return () => { (dnsPromises as { lookup: unknown }).lookup = original; };
}

async function startApp(): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', createWebhooksRouter());
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve({ server, base: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function postWebhook(base: string, url: string): Promise<{ status: number; error?: string }> {
  const res = await fetch(`${base}/api/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, events: ['run_completed'] }),
  });
  const json = await res.json().catch(() => ({})) as { error?: string };
  return { status: res.status, error: json.error };
}

let activeServer: Server | null = null;

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
    activeServer = null;
  }
  closeDb();
});

test('POST /api/webhooks rejects private literal URLs', async () => {
  initDb(':memory:');
  const { server, base } = await startApp();
  activeServer = server;

  const res = await postWebhook(base, 'http://127.0.0.1:9000/hook');

  assert.equal(res.status, 400);
  assert.match(res.error ?? '', /blocked|private/i);
});

test('POST /api/webhooks rejects metadata hostnames', async () => {
  initDb(':memory:');
  const { server, base } = await startApp();
  activeServer = server;

  const res = await postWebhook(base, 'http://metadata.google.internal/hook');

  assert.equal(res.status, 400);
  assert.match(res.error ?? '', /blocked|private/i);
});

test('POST /api/webhooks rejects hostnames that resolve to private addresses', async () => {
  initDb(':memory:');
  const restoreDns = stubDns([{ address: '10.1.2.3', family: 4 }]);
  const { server, base } = await startApp();
  activeServer = server;

  try {
    const res = await postWebhook(base, 'https://internal.example.test/hook');
    assert.equal(res.status, 400);
    assert.match(res.error ?? '', /blocked|private/i);
  } finally {
    restoreDns();
  }
});

test('POST /api/webhooks accepts a public webhook URL', async () => {
  initDb(':memory:');
  const restoreDns = stubDns([{ address: '93.184.216.34', family: 4 }]);
  const { server, base } = await startApp();
  activeServer = server;

  try {
    const res = await fetch(`${base}/api/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://hooks.example.test/ok', events: ['run_completed'] }),
    });
    assert.equal(res.status, 201);
    const json = await res.json() as { webhook: { url: string } };
    assert.equal(json.webhook.url, 'https://hooks.example.test/ok');
  } finally {
    restoreDns();
  }
});
