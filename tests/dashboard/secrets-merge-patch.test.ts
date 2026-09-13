import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { KubeConfig, Observable, ResponseContext, ServerConfiguration, createConfiguration } from '@kubernetes/client-node';
import type { ApiType, Configuration, HttpLibrary, RequestContext } from '@kubernetes/client-node';

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
        { text: async () => '{}', binary: async () => Buffer.from(''), stream: () => null },
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

function restoreEnv(keys: string[]): () => void {
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

async function bootSecretsRouter(t: TestContext, bust: string): Promise<string> {
  const { createSecretsRouter } = await import(`../../src/dashboard-server/routes/secrets.js?bust=${bust}`);
  const app = express();
  app.use(express.json());
  app.use('/api/secrets', createSecretsRouter());
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('PUT /api/secrets/:envVar patches with the merge-patch content type and an unchanged body', async (t) => {
  t.after(restoreEnv(['KUBERNETES_SERVICE_HOST', 'KUBE_NAMESPACE', 'KUBE_SECRET_NAME']));
  process.env.KUBERNETES_SERVICE_HOST = '127.0.0.1';
  process.env.KUBE_NAMESPACE = 'arena-test';
  process.env.KUBE_SECRET_NAME = 'provider-keys-test';

  const captured: CapturedK8sRequest[] = [];
  const config = testConfig(captured);
  t.mock.method(KubeConfig.prototype, 'loadFromDefault', () => {});
  t.mock.method(KubeConfig.prototype, 'makeApiClient', apiClientFactory(config));

  const base = await bootSecretsRouter(t, 'put');
  const res = await fetch(`${base}/api/secrets/FEATURE_KEY`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'sk-test-1234' }),
  });
  assert.equal(res.status, 200);

  const patch = captured.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'secret patch was issued');
  assert.equal(
    patch.headers['Content-Type'],
    'application/merge-patch+json',
    'generated client defaults to JSON Patch; the object body requires merge patch',
  );
  assert.equal(patch.url, 'http://k8s.test/api/v1/namespaces/arena-test/secrets/provider-keys-test');
  assert.deepEqual(JSON.parse(String(patch.body)), { stringData: { FEATURE_KEY: 'sk-test-1234' } });
});

test('DELETE /api/secrets/:envVar patches with the merge-patch content type and an unchanged body', async (t) => {
  t.after(restoreEnv(['KUBERNETES_SERVICE_HOST', 'KUBE_NAMESPACE', 'KUBE_SECRET_NAME']));
  process.env.KUBERNETES_SERVICE_HOST = '127.0.0.1';
  process.env.KUBE_NAMESPACE = 'arena-test';
  process.env.KUBE_SECRET_NAME = 'provider-keys-test';

  const captured: CapturedK8sRequest[] = [];
  const config = testConfig(captured);
  t.mock.method(KubeConfig.prototype, 'loadFromDefault', () => {});
  t.mock.method(KubeConfig.prototype, 'makeApiClient', apiClientFactory(config));

  const base = await bootSecretsRouter(t, 'delete');
  const res = await fetch(`${base}/api/secrets/FEATURE_KEY`, { method: 'DELETE' });
  assert.equal(res.status, 200);

  const patch = captured.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'secret patch was issued');
  assert.equal(patch.headers['Content-Type'], 'application/merge-patch+json');
  assert.deepEqual(JSON.parse(String(patch.body)), { stringData: { FEATURE_KEY: null } });
});
