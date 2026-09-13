import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireAuth, signToken, loadAuthConfig } from '../../src/dashboard-server/auth.js';
import { requireRole, apiKeyImpliedRole } from '../../src/auth/rbac.js';
import { requireApiKey, loadApiKeysConfig } from '../../src/dashboard-server/auth-api.js';
import { createRegressionRouter } from '../../src/dashboard-server/routes/regression.js';
import { closeDb } from '../../src/db/index.js';

process.env.DASHBOARD_JWT_SECRET = 'a'.repeat(32);
process.env.DASHBOARD_PASSWORD = 'rbac-test-pass';

function makeApp() {
  const auth = loadAuthConfig();
  const app = express();
  app.use(express.json());

  app.get('/api/viewer', requireAuth(auth), requireRole('viewer'), (_req, res) => {
    res.json({ ok: true, role: 'viewer' });
  });
  app.get('/api/editor', requireAuth(auth), requireRole('editor'), (_req, res) => {
    res.json({ ok: true, role: 'editor' });
  });
  app.get('/api/admin', requireAuth(auth), requireRole('admin'), (_req, res) => {
    res.json({ ok: true, role: 'admin' });
  });
  return app;
}

function tokenFor(role: string): string {
  const auth = loadAuthConfig();
  return signToken(auth, 'admin', role);
}

async function doGet(port: number, path: string, authHeader?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (authHeader) headers.authorization = authHeader;
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer<T>(app: express.Express, fn: (port: number) => Promise<T>): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await fn(port);
  } finally {
    server.close();
  }
}

test('unauthenticated requests receive 401', async () => {
  await withServer(makeApp(), async (port) => {
    const r = await doGet(port, '/api/viewer');
    assert.equal(r.status, 401);
  });
});

test('admin role can access viewer/editor/admin endpoints', async () => {
  const token = tokenFor('admin');
  await withServer(makeApp(), async (port) => {
    assert.equal((await doGet(port, '/api/viewer', `Bearer ${token}`)).status, 200);
    assert.equal((await doGet(port, '/api/editor', `Bearer ${token}`)).status, 200);
    assert.equal((await doGet(port, '/api/admin', `Bearer ${token}`)).status, 200);
  });
});

test('viewer role can access viewer, denied editor and admin', async () => {
  const token = tokenFor('viewer');
  await withServer(makeApp(), async (port) => {
    assert.equal((await doGet(port, '/api/viewer', `Bearer ${token}`)).status, 200);
    assert.equal((await doGet(port, '/api/editor', `Bearer ${token}`)).status, 403);
    assert.equal((await doGet(port, '/api/admin', `Bearer ${token}`)).status, 403);
  });
});

test('editor role can access viewer and editor, denied admin', async () => {
  const token = tokenFor('editor');
  await withServer(makeApp(), async (port) => {
    assert.equal((await doGet(port, '/api/viewer', `Bearer ${token}`)).status, 200);
    assert.equal((await doGet(port, '/api/editor', `Bearer ${token}`)).status, 200);
    assert.equal((await doGet(port, '/api/admin', `Bearer ${token}`)).status, 403);
  });
});

test('malformed token returns 401', async () => {
  await withServer(makeApp(), async (port) => {
    const r = await doGet(port, '/api/viewer', 'Bearer not.a.real.token');
    assert.equal(r.status, 401);
  });
});

test('wrong auth scheme returns 401', async () => {
  const token = tokenFor('viewer');
  await withServer(makeApp(), async (port) => {
    const r = await doGet(port, '/api/viewer', `Basic ${token}`);
    assert.equal(r.status, 401);
  });
});

test('regression:execute implies the editor role', () => {
  assert.equal(apiKeyImpliedRole({ permissions: ['regression:execute'] }), 'editor');
});

test('API-key write permissions pass the inner role gates (v1 write surface)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-apikeys-'));
  const configPath = path.join(tmp, 'api-keys.yaml');
  fs.writeFileSync(configPath, [
    'apiKeys:',
    '  - name: writer',
    '    key: WRITER_KEY_1',
    '    permissions: [runs:read, runs:write, models:write, sessions:read, sessions:write, ops:admin]',
    '  - name: reader',
    '    key: READER_KEY_1',
    '    permissions: [runs:read, anomalies:read]',
    '  - name: regression',
    '    key: REGRESSION_KEY_1',
    '    permissions: [regression:execute]',
  ].join('\n'));

  process.env.AI_ARENA_ROOT = tmp;
  process.env.OUTPUT_ROOT = tmp;

  const app = express();
  app.use(express.json());
  // Mirrors the real /api/v1 mount shape: requireApiKey (read-level at the
  // mount) then the router's inner role gates, which now honor API-key
  // write permissions via apiKeyImpliedRole.
  app.post('/api/v1/runs', requireApiKey(['runs:read']), requireRole('editor'), (_req, res) => {
    res.status(201).json({ ok: true });
  });
  app.get('/api/v1/anomalies', requireApiKey(['anomalies:read']), requireRole('viewer'), (_req, res) => {
    res.json({ ok: true });
  });
  app.patch('/api/v1/anomalies/:id', requireApiKey(['anomalies:read']), requireRole('editor'), (_req, res) => {
    res.json({ ok: true });
  });
  app.delete('/api/v1/sessions/:id', requireApiKey(['sessions:read']), requireRole('admin'), (_req, res) => {
    res.json({ ok: true });
  });
  // Real regression router: the mount requires regression:execute and the
  // router's POST gate must accept the role that permission implies.
  app.use('/api/v1/regression', requireApiKey(['regression:execute']), createRegressionRouter());

  try {
    // Prime the module-level api-keys config cache from this file (set once,
    // like server.ts:208 does at boot).
    loadApiKeysConfig(configPath);
    await withServer(app, async (port) => {
      const doReq = (method: string, p: string, key: string): Promise<{ status: number }> =>
        new Promise((resolve, reject) => {
          const req = http.request({
            hostname: '127.0.0.1', port, path: p, method,
            headers: { 'x-api-key': key },
          }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0 })); });
          req.on('error', reject);
          req.end();
        });

      // Writer key: runs:write implies editor → the POST passes.
      assert.equal((await doReq('POST', '/api/v1/runs', 'WRITER_KEY_1')).status, 201);
      // Writer key also carries ops:admin → admin-gated DELETE passes.
      assert.equal((await doReq('DELETE', '/api/v1/sessions/x', 'WRITER_KEY_1')).status, 200);
      // Reader key: read-only → the editor gate denies the write.
      assert.equal((await doReq('POST', '/api/v1/runs', 'READER_KEY_1')).status, 403);
      // Reader key: viewer-level read passes the anomalies read gate.
      assert.equal((await doReq('GET', '/api/v1/anomalies', 'READER_KEY_1')).status, 200);
      // Reader key without anomalies:write is denied the PATCH (editor gate).
      assert.equal((await doReq('PATCH', '/api/v1/anomalies/1', 'READER_KEY_1')).status, 403);
      // Regression key passes both gates and reaches the handler, which
      // rejects the empty body with 400 (not the gates' 403).
      assert.equal((await doReq('POST', '/api/v1/regression', 'REGRESSION_KEY_1')).status, 400);
      // Reader key lacks regression:execute → denied at the mount.
      assert.equal((await doReq('POST', '/api/v1/regression', 'READER_KEY_1')).status, 403);
      // Unknown key → 401.
      assert.equal((await doReq('POST', '/api/v1/runs', 'NOPE')).status, 401);
    });
  } finally {
    await closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.AI_ARENA_ROOT;
    delete process.env.OUTPUT_ROOT;
  }
});
