import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { KubeConfig, Observable, ResponseContext, ServerConfiguration, createConfiguration } from '@kubernetes/client-node';
import type { ApiType, Configuration, HttpLibrary, RequestContext } from '@kubernetes/client-node';

/**
 * Regression: @kubernetes/client-node throws ApiException with a numeric
 * `.code` (no `response.statusCode`). A missing provider-keys Secret must
 * therefore still hit the create fallback (PUT) / empty list (GET).
 */

interface CapturedK8sRequest {
  method: string;
  url: string;
  body: unknown;
}

function recordingK8sHttp(captured: CapturedK8sRequest[], missingStatus = 404): HttpLibrary {
  return {
    send(request: RequestContext) {
      const method = request.getHttpMethod().toString();
      captured.push({ method, url: request.getUrl(), body: request.getBody() });
      const status = method === 'POST' ? 201 : missingStatus;
      return new Observable(Promise.resolve(new ResponseContext(
        status,
        { 'content-type': 'application/json' },
        {
          text: async () => (status >= 300 ? `{"kind":"Status","code":${status}}` : '{}'),
          binary: async () => Buffer.from(''),
          stream: () => null,
        },
      )));
    },
  };
}

function apiClientFactory(config: Configuration) {
  return <T extends ApiType>(apiClientType: new (configuration: Configuration) => T): T => new apiClientType(config);
}

function testConfig(httpApi: HttpLibrary): Configuration {
  return createConfiguration({
    baseServer: new ServerConfiguration('http://k8s.test', {}),
    httpApi,
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

function useK8sEnv(t: TestContext): void {
  t.after(restoreEnv(['KUBERNETES_SERVICE_HOST', 'KUBE_NAMESPACE', 'KUBE_SECRET_NAME']));
  process.env.KUBERNETES_SERVICE_HOST = '127.0.0.1';
  process.env.KUBE_NAMESPACE = 'arena-test';
  process.env.KUBE_SECRET_NAME = 'provider-keys-test';
}

test('PUT falls back to creating provider-keys when the patch returns 404', async (t) => {
  useK8sEnv(t);
  const captured: CapturedK8sRequest[] = [];
  t.mock.method(KubeConfig.prototype, 'loadFromDefault', () => {});
  t.mock.method(KubeConfig.prototype, 'makeApiClient', apiClientFactory(testConfig(recordingK8sHttp(captured))));

  const base = await bootSecretsRouter(t, '404-put');
  const res = await fetch(`${base}/api/secrets/FEATURE_KEY`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'sk-test-1234' }),
  });
  assert.equal(res.status, 200);

  const methods = captured.map((c) => c.method);
  assert.deepEqual(methods, ['PATCH', 'POST'], '404 on patch triggers the create fallback');
  const create = captured[1];
  assert.equal(create?.url, 'http://k8s.test/api/v1/namespaces/arena-test/secrets');
  assert.deepEqual(JSON.parse(String(create?.body)), {
    metadata: { name: 'provider-keys-test', namespace: 'arena-test' },
    stringData: { FEATURE_KEY: 'sk-test-1234' },
  });
});

test('GET returns an empty list when provider-keys does not exist (404)', async (t) => {
  useK8sEnv(t);
  const captured: CapturedK8sRequest[] = [];
  t.mock.method(KubeConfig.prototype, 'loadFromDefault', () => {});
  t.mock.method(KubeConfig.prototype, 'makeApiClient', apiClientFactory(testConfig(recordingK8sHttp(captured))));

  const base = await bootSecretsRouter(t, '404-get');
  const res = await fetch(`${base}/api/secrets`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { platform: 'kubernetes', secrets: [] });
  assert.deepEqual(captured.map((c) => c.method), ['GET']);
});
