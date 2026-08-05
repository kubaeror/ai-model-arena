import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { initDb, closeDb } from '../../src/db/index.js';
import type { SuiteResult } from '../../src/evaluation/regression.js';

function suiteResult(overrides: Partial<SuiteResult>): SuiteResult {
  return {
    suite: 'suite',
    runId: 'regress-x',
    model: 'gpt-4o',
    scenarioResults: [],
    passed: true,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('GET /api/regression/results returns newest saved results across suites', async (t) => {
  if (typeof (t.mock as { module?: unknown }).module !== 'function') {
    t.skip('t.mock.module requires --experimental-test-module-mocks (provided by npm test)');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-regression-routes-'));
  const regressionDir = path.join(dir, 'regression');

  // Two suites with results, one with a corrupt file, one stray non-directory file.
  fs.mkdirSync(path.join(regressionDir, 'suite-a'), { recursive: true });
  fs.mkdirSync(path.join(regressionDir, 'suite-b'), { recursive: true });
  fs.mkdirSync(path.join(regressionDir, 'suite-c'), { recursive: true });
  fs.mkdirSync(path.join(regressionDir, 'broken'), { recursive: true });
  fs.writeFileSync(
    path.join(regressionDir, 'suite-a', 'regression-results.json'),
    JSON.stringify(suiteResult({ suite: 'suite-a', runId: 'regress-1', passed: true, timestamp: '2026-01-01T00:00:00.000Z' }), null, 2),
  );
  fs.writeFileSync(
    path.join(regressionDir, 'suite-b', 'regression-results.json'),
    JSON.stringify(suiteResult({ suite: 'suite-b', runId: 'regress-2', passed: false, timestamp: '2026-01-03T00:00:00.000Z' }), null, 2),
  );
  fs.writeFileSync(
    path.join(regressionDir, 'suite-c', 'regression-results.json'),
    JSON.stringify(suiteResult({ suite: 'suite-c', runId: 'regress-3', passed: true, timestamp: '2026-01-02T00:00:00.000Z' }), null, 2),
  );
  fs.writeFileSync(path.join(regressionDir, 'broken', 'regression-results.json'), '{not-json');
  fs.writeFileSync(path.join(regressionDir, 'stray.json'), '{}');

  t.mock.module('../../src/paths.js', {
    exports: {
      findProjectRoot: () => dir,
      outputRoot: () => dir,
      dbPath: () => path.join(dir, 'arena.db'),
    },
  });
  initDb(path.join(dir, 'arena.db'));

  const { createRegressionRouter } = await import('../../src/dashboard-server/routes/regression.js');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { user?: { sub: string; role: string } }).user = { sub: 'viewer', role: 'viewer' };
    next();
  });
  app.use('/api/regression', createRegressionRouter());

  const server: http.Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const res = await fetch(`${base}/api/regression/results`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { results: SuiteResult[] };
    assert.equal(body.results.length, 3, 'corrupt and stray files are skipped');
    assert.deepEqual(body.results.map((r) => r.suite), ['suite-b', 'suite-c', 'suite-a'], 'sorted newest-first');

    const limited = await fetch(`${base}/api/regression/results?limit=2`);
    assert.equal(limited.status, 200);
    const limitedBody = (await limited.json()) as { results: SuiteResult[] };
    assert.deepEqual(limitedBody.results.map((r) => r.suite), ['suite-b', 'suite-c'], 'limit returns newest N');

    const invalid = await fetch(`${base}/api/regression/results?limit=0`);
    assert.equal(invalid.status, 200);
    assert.equal(((await invalid.json()) as { results: SuiteResult[] }).results.length, 3, 'limit=0 falls back to default');
  } finally {
    server.close();
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
