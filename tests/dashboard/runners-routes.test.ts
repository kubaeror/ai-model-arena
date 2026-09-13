import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RequestHandler } from 'express';
import { KubeConfig, Observable, ResponseContext, ServerConfiguration, createConfiguration } from '@kubernetes/client-node';
import type { ApiType, Configuration, HttpLibrary, RequestContext } from '@kubernetes/client-node';

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

interface CapturedK8sRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function captureK8sRequests(captured: CapturedK8sRequest[]): HttpLibrary {
  return {
    send(request: RequestContext) {
      captured.push({
        method: request.getHttpMethod().toString(),
        url: request.getUrl(),
        headers: request.getHeaders(),
        body: request.getBody(),
      });
      return new Observable(Promise.resolve(new ResponseContext(
        200,
        { 'content-type': 'application/json' },
        { text: async () => '{}', binary: async () => Buffer.from('') },
      )));
    },
  };
}

function apiClientFactory(config: Configuration) {
  return <T extends ApiType>(apiClientType: new (configuration: Configuration) => T): T => new apiClientType(config);
}

function testConfig(captured: CapturedK8sRequest[]): Configuration {
  return createConfiguration({
    baseServer: new ServerConfiguration('http://k8s.test', {}),
    httpApi: captureK8sRequests(captured),
    authMethods: {},
  });
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

test('scale and drain patch deployments with the merge-patch content type and unchanged bodies', async (t) => {
  const captured: CapturedK8sRequest[] = [];
  const config = testConfig(captured);
  t.mock.method(KubeConfig.prototype, 'loadFromDefault', () => {});
  t.mock.method(KubeConfig.prototype, 'makeApiClient', apiClientFactory(config));

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

  const scale = await fetch(`${base}/api/runners/runner-openai/scale`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replicas: 2 }),
  });
  assert.equal(scale.status, 200);

  const drain = await fetch(`${base}/api/runners/runner-openai/drain`, { method: 'POST' });
  assert.equal(drain.status, 200);

  assert.equal(captured.length, 2, 'both patches reached the HTTP library');
  for (const patch of captured) {
    assert.equal(patch.method, 'PATCH');
    assert.equal(
      patch.headers['Content-Type'],
      'application/merge-patch+json',
      'generated client defaults to JSON Patch; the object body requires merge patch',
    );
    assert.equal(patch.url, 'http://k8s.test/apis/apps/v1/namespaces/ai-arena/deployments/runner-openai');
  }
  assert.deepEqual(JSON.parse(String(captured[0]!.body)), { spec: { replicas: 2 } });
  assert.deepEqual(JSON.parse(String(captured[1]!.body)), { spec: { replicas: 0 } });
});
