/**
 * OpenAPI conformance test.
 *
 * Two-way contract between the dashboard server and openapi.yaml:
 *
 *  1. Every HTTP route the server actually mounts MUST be documented in
 *     openapi.yaml (path params normalized `:param` → `{param}`).
 *  2. Every documented HTTP path MUST exist in the server code — this kills
 *     phantom paths like the old /catalog/providers (handled by /api/providers).
 *  3. WebSocket endpoints (/ws, /runner, /lobby) MUST be documented as `ws`
 *     entries with descriptions, and no other ws entries may exist.
 *
 * The mounted-router list below mirrors src/dashboard-server/server.ts
 * (mounts at lines 261-346, direct routes at 126-321, docs at 349, WS at
 * 372-382). Per-router paths are extracted from the real router factories so
 * route drift inside a router is caught automatically; only the mount
 * prefixes are mirrored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type RequestHandler, type Router } from 'express';
import { load } from 'js-yaml';

import { initDb } from '../../src/db/index.js';
import { createModelsRouter } from '../../src/dashboard-server/routes/models.js';
import { createScenariosRouter } from '../../src/dashboard-server/routes/scenarios.js';
import { createRunsRouter } from '../../src/dashboard-server/routes/runs.js';
import { createAnalyticsRouter } from '../../src/dashboard-server/routes/analytics.js';
import { createExportRouter } from '../../src/dashboard-server/routes/export.js';
import { createTracesRouter } from '../../src/dashboard-server/routes/traces.js';
import { createAnomaliesRouter } from '../../src/dashboard-server/routes/anomalies.js';
import { createObservabilityRouter } from '../../src/dashboard-server/routes/observability.js';
import { createWebhooksRouter } from '../../src/dashboard-server/routes/webhooks.js';
import { createProvidersRouter } from '../../src/dashboard-server/routes/providers.js';
import { createCatalogRouter } from '../../src/dashboard-server/routes/catalog.js';
import { createMetricsRouter } from '../../src/dashboard-server/routes/metrics.js';
import { createCacheRouter } from '../../src/dashboard-server/routes/cache.js';
import { createBudgetRouter } from '../../src/dashboard-server/routes/budget.js';
import { createSchedulesRouter } from '../../src/dashboard-server/routes/schedules.js';
import { createRegressionRouter } from '../../src/dashboard-server/routes/regression.js';
import { createSecretsRouter } from '../../src/dashboard-server/routes/secrets.js';
import { createPromptsRouter } from '../../src/dashboard-server/routes/prompts.js';
import { createOutputMappingsRouter } from '../../src/dashboard-server/routes/output-mappings.js';
import { createSessionsRouter } from '../../src/dashboard-server/routes/sessions.js';
import { createUsersRouter } from '../../src/dashboard-server/routes/users.js';
import { createAuditRouter } from '../../src/dashboard-server/routes/audit.js';
import { createFilesRouter } from '../../src/dashboard-server/routes/files.js';
import { registerRunnerRoutes } from '../../src/dashboard-server/routes/runners.js';
import { registerQueueRoutes } from '../../src/dashboard-server/routes/queues.js';

const SPEC_PATH = fileURLToPath(new URL('../../openapi.yaml', import.meta.url));

/** Mirror of server.ts:261-285 — JWT-authenticated /api/* router mounts. */
const JWT_MOUNTS: Array<[string, () => Router]> = [
  ['/api/models', createModelsRouter],
  ['/api/scenarios', createScenariosRouter],
  ['/api/runs', createRunsRouter],
  ['/api/traces', createTracesRouter],
  ['/api/anomalies', createAnomaliesRouter],
  ['/api/observability', createObservabilityRouter],
  ['/api/webhooks', createWebhooksRouter],
  ['/api/providers', createProvidersRouter],
  ['/api/secrets', createSecretsRouter],
  ['/api/catalog', createCatalogRouter],
  ['/api/metrics', createMetricsRouter],
  ['/api/cache', createCacheRouter],
  ['/api/analytics', createAnalyticsRouter],
  ['/api/export', createExportRouter],
  ['/api/prompts', createPromptsRouter],
  ['/api/output-mappings', createOutputMappingsRouter],
  ['/api/sessions', createSessionsRouter],
  ['/api/users', createUsersRouter],
  ['/api/audit', createAuditRouter],
  ['/api/files', createFilesRouter],
  ['/api/budget', createBudgetRouter],
  ['/api/schedules', createSchedulesRouter],
  ['/api/regression', createRegressionRouter],
];

/** Mirror of server.ts:325-346 — API-key-authenticated /api/v1/* mounts. */
const V1_MOUNTS: Array<[string, () => Router]> = [
  ['/api/v1/models', createModelsRouter],
  ['/api/v1/scenarios', createScenariosRouter],
  ['/api/v1/runs', createRunsRouter],
  ['/api/v1/analytics', createAnalyticsRouter],
  ['/api/v1/export', createExportRouter],
  ['/api/v1/traces', createTracesRouter],
  ['/api/v1/anomalies', createAnomaliesRouter],
  ['/api/v1/observability', createObservabilityRouter],
  ['/api/v1/webhooks', createWebhooksRouter],
  ['/api/v1/providers', createProvidersRouter],
  ['/api/v1/catalog', createCatalogRouter],
  ['/api/v1/metrics', createMetricsRouter],
  ['/api/v1/cache', createCacheRouter],
  ['/api/v1/budget', createBudgetRouter],
  ['/api/v1/schedules', createSchedulesRouter],
  ['/api/v1/regression', createRegressionRouter],
  ['/api/v1/files', createFilesRouter],
  ['/api/v1/sessions', createSessionsRouter],
  ['/api/v1/prompts', createPromptsRouter],
  ['/api/v1/output-mappings', createOutputMappingsRouter],
];

/** Direct routes registered inline in server.ts (health/metrics/auth/roles/ops/docs). */
const DIRECT_ROUTES: Array<[string, string]> = [
  ['GET', '/health'],
  ['GET', '/metrics'],
  ['POST', '/api/auth/login'],
  ['POST', '/api/auth/logout'],
  ['GET', '/api/roles'],
  ['POST', '/api/ops/killswitch'],
  ['DELETE', '/api/ops/killswitch'],
  ['GET', '/api/ops/killswitch'],
  ['GET', '/api/docs'],
  ['GET', '/api/docs/openapi.yaml'],
  ['GET', '/api/docs/openapi.json'],
  ['GET', '/api/v1/docs'],
];

/** WebSocket endpoints: /ws (LiveHub), /runner + /lobby (stream relay). */
const WS_PATHS = ['/ws', '/runner', '/lobby'];

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface RouteLayer {
  route?: { path: unknown; methods: Record<string, boolean> };
}
type StackedRouter = { stack: RouteLayer[] };

const noopAuth: RequestHandler = (_req, _res, next) => next();

/** Normalize `:param` and `*splat` to `{param}` / `{splat}`; strip trailing slashes. */
function normalizePath(p: string): string {
  return p
    .replace(/\/+$/, '')
    .replace(/:[^/]+/g, (m) => `{${m.slice(1)}}`)
    .replace(/\*[^/]*/g, (m) => `{${m.slice(1) || 'splat'}}`);
}

/** Extract `METHOD /full/path` entries from a router's stack (no prefix joining). */
function routesOf(router: Router): string[] {
  const out: string[] = [];
  for (const layer of (router as unknown as StackedRouter).stack) {
    if (layer.route && typeof layer.route.path === 'string') {
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        out.push(`${method.toUpperCase()} ${normalizePath(layer.route.path)}`);
      }
    }
  }
  return out;
}

/** Routes from one mounted router: prefix (server.ts mount) + relative route paths. */
function routesOfMount(prefix: string, router: Router): string[] {
  return routesOf(router).map((entry) => {
    const [method, rel] = entry.split(' ', 2);
    const relPath = rel === '' || rel === '/' ? '' : rel;
    return `${method} ${normalizePath(`${prefix}${relPath}`)}`;
  });
}

/** Full set of real `METHOD /path` entries, mirroring server.ts mounts. */
function realRoutes(): Set<string> {
  const real = new Set<string>();
  for (const [method, p] of DIRECT_ROUTES) real.add(`${method} ${normalizePath(p)}`);
  for (const [prefix, router] of JWT_ROUTERS) {
    for (const entry of routesOfMount(prefix, router)) real.add(entry);
  }
  for (const [prefix, router] of V1_ROUTERS) {
    for (const entry of routesOfMount(prefix, router)) real.add(entry);
  }
  // registerRunnerRoutes / registerQueueRoutes register full paths directly
  // on the app; collect them from a scratch app the same way server.ts mounts them.
  const app = express();
  registerRunnerRoutes(app, noopAuth);
  registerQueueRoutes(app, noopAuth);
  for (const entry of routesOf((app as unknown as { router: Router }).router)) real.add(entry);
  return real;
}

function loadSpec(): { paths: Record<string, { ws?: { description?: string } } & Record<string, unknown>> } {
  const parsed = load(fs.readFileSync(SPEC_PATH, 'utf8')) as Record<string, unknown>;
  assert.equal(typeof parsed, 'object');
  assert.equal(parsed.openapi, '3.0.3');
  assert.ok(parsed.paths && typeof parsed.paths === 'object');
  return parsed as never;
}

/** All documented `METHOD /path` entries (HTTP operations only). */
function docHttpEntries(spec: ReturnType<typeof loadSpec>): string[] {
  const out: string[] = [];
  for (const [pathKey, ops] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      if (ops[method] && typeof ops[method] === 'object') {
        out.push(`${method.toUpperCase()} ${normalizePath(pathKey)}`);
      }
    }
  }
  return out;
}

// ── Setup: some factories touch the DB at creation time (users seeding,
//    regression initDb) — point them at a throwaway SQLite file. ──────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-openapi-conformance-'));
process.env.ARENA_DB_PATH = path.join(tmpDir, 'arena.db');
initDb(process.env.ARENA_DB_PATH);

// Build each router exactly once (the server mounts each once; recreating a
// router per test would re-trigger the users router's async role/admin seeding
// and race against itself).
const JWT_ROUTERS: Array<[string, Router]> = JWT_MOUNTS.map(([p, f]) => [p, f()]);
const V1_ROUTERS: Array<[string, Router]> = V1_MOUNTS.map(([p, f]) => [p, f()]);

test('every real route is documented in openapi.yaml', () => {
  const real = realRoutes();
  const documented = new Set(docHttpEntries(loadSpec()));
  const missing = [...real].filter((r) => !documented.has(r)).sort();
  assert.deepEqual(
    missing,
    [],
    `Real routes missing from openapi.yaml (${missing.length}):\n  ${missing.join('\n  ')}`,
  );
});

test('every documented path exists in the server code (no phantom paths)', () => {
  const real = realRoutes();
  const phantom = docHttpEntries(loadSpec()).filter((d) => !real.has(d)).sort();
  assert.deepEqual(
    phantom,
    [],
    `Documented paths that do not exist in the server code (${phantom.length}):\n  ${phantom.join('\n  ')}`,
  );
});

test('WebSocket endpoints are documented as ws entries with descriptions', () => {
  const spec = loadSpec();
  const wsPaths = Object.entries(spec.paths)
    .filter(([, ops]) => ops.ws && typeof ops.ws === 'object')
    .map(([p]) => p)
    .sort();
  assert.deepEqual(wsPaths, [...WS_PATHS].sort(), 'ws entries must be exactly /ws, /runner, /lobby');
  for (const wsPath of WS_PATHS) {
    assert.ok(typeof spec.paths[wsPath]!.ws?.description === 'string', `${wsPath} ws entry has a description`);
    assert.ok((spec.paths[wsPath]!.ws?.description ?? '').length > 0, `${wsPath} ws description is non-empty`);
  }
});
