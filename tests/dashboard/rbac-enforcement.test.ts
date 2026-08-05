import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { requireAuth, signToken, loadAuthConfig } from '../../src/dashboard-server/auth.js';
import { requireRole } from '../../src/auth/rbac.js';

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
