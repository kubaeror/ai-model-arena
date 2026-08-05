import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RequestHandler } from 'express';

const BAD_KUBECONFIG = '/nonexistent/kube/config';

function restoreEnv(keys: string[]): () => void {
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test('runners route module imports without kubeconfig (KUBECONFIG points at a nonexistent path)', async (t) => {
  t.after(restoreEnv(['KUBECONFIG']));
  process.env.KUBECONFIG = BAD_KUBECONFIG;

  let mod: unknown = null;
  await assert.doesNotReject(async () => {
    mod = await import('../../src/dashboard-server/routes/runners.js');
  });
  assert.ok(mod, 'module imported successfully');
  assert.equal(typeof (mod as { registerRunnerRoutes: unknown }).registerRunnerRoutes, 'function');
});

test('handlers return 503 k8s API unavailable when kubeconfig cannot load', async (t) => {
  t.after(restoreEnv(['KUBECONFIG']));
  process.env.KUBECONFIG = BAD_KUBECONFIG;

  const { registerRunnerRoutes } = await import('../../src/dashboard-server/routes/runners.js');
  const app = express();
  app.use(express.json());
  const auth: RequestHandler = (req, _res, next) => {
    (req as { user?: { sub: string; role: string } }).user = { sub: 'admin', role: 'admin' };
    next();
  };
  registerRunnerRoutes(app, auth);

  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const routes: Array<{ method: string; path: string; body?: unknown }> = [
    { method: 'GET', path: '/api/runners' },
    { method: 'POST', path: '/api/runners/runner-openai/scale', body: { replicas: 1 } },
    { method: 'POST', path: '/api/runners/runner-openai/drain' },
    { method: 'GET', path: '/api/runners/runner-openai/logs' },
  ];
  for (const { method, path, body } of routes) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(res.status, 503, `${method} ${path} returns 503`);
    const payload = (await res.json()) as { error: string };
    assert.equal(payload.error, 'k8s API unavailable');
  }
});
