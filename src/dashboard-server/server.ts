import 'dotenv/config';
import '../env.js';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { findProjectRoot, dbPath } from '../paths.js';
import { createLogger } from '../logger/pino-logger.js';
import { startOtel } from '../observability/otel.js';
import { metricsHandler } from '../observability/metrics.js';
import { initDb, closeDb, getDb, getDriver } from '../db/index.js';
import { ensureFresh } from '../catalog/cache.js';
import { startCatalogCron, stopCatalogCron } from '../catalog/cron.js';
import { loadAuthConfig, requireAuth, verifyCredentials, signToken, revokeToken, setTokenCookie, clearTokenCookie, type AuthedRequest } from './auth.js';
import { requireRole } from '../auth/rbac.js';
import { maskSecrets } from './secrets.js';
import { loadApiKeysConfig, requireApiKey } from './auth-api.js';
import { LiveHub } from './live.js';
import { createModelsRouter } from './routes/models.js';
import { createScenariosRouter } from './routes/scenarios.js';
import { createRunsRouter } from './routes/runs.js';
import { createAnalyticsRouter } from './routes/analytics.js';
import { createExportRouter } from './routes/export.js';
import { createTracesRouter } from './routes/traces.js';
import { createAnomaliesRouter } from './routes/anomalies.js';
import { createObservabilityRouter } from './routes/observability.js';
import { createWebhooksRouter } from './routes/webhooks.js';
import { createProvidersRouter } from './routes/providers.js';
import { createCatalogRouter } from './routes/catalog.js';
import { createMetricsRouter } from './routes/metrics.js';
import { createCacheRouter } from './routes/cache.js';
import { createBudgetRouter } from './routes/budget.js';
import { createSchedulesRouter } from './routes/schedules.js';
import { createRegressionRouter } from './routes/regression.js';
import { createSecretsRouter } from './routes/secrets.js';
import { registerRunnerRoutes } from './routes/runners.js';
import { registerQueueRoutes } from './routes/queues.js';
import { createPromptsRouter } from './routes/prompts.js';
import { createOutputMappingsRouter } from './routes/output-mappings.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createUsersRouter } from './routes/users.js';
import { createAuditRouter } from './routes/audit.js';
import { createCostRouter } from './routes/cost.js';
import { createFilesRouter } from './routes/files.js';
import { attachStreamWs } from './routes/stream.js';
import { mountOpenApi } from './openapi.js';

const logger = createLogger('ai-arena:dashboard');

function clientDist(): string {
  return path.join(findProjectRoot(), 'src', 'dashboard-client', 'dist');
}

async function start(): Promise<void> {
  startOtel();
  const port = Number(process.env.DASHBOARD_PORT ?? 4000);
  const auth = loadAuthConfig();
  if (auth.generatedPassword) {
    process.stderr.write(
      '\n' +
      '╔══════════════════════════════════════════════════════════════════╗\n' +
      '║  WARNING: No DASHBOARD_PASSWORD set — generated a one-time      ║\n' +
      '║  admin password. This password will NOT be shown again and is   ║\n' +
      '║  NOT written to logs. Save it now or set DASHBOARD_PASSWORD in  ║\n' +
      '║  your environment to a known value.                              ║\n' +
      `║  Password: ${auth.generatedPassword.padEnd(48)}║\n` +
      '╚══════════════════════════════════════════════════════════════════╝\n\n',
    );
    logger.warn('No DASHBOARD_PASSWORD set — a one-time password was generated (see stderr output). It will not be shown again.');
  }
  const root = findProjectRoot();
  const allowedOrigins = (process.env.DASHBOARD_CORS_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const resolvedDbPath = dbPath();
  initDb(resolvedDbPath);
  logger.info('SQLite catalog DB initialized', { dbPath: resolvedDbPath });

  // Boot: block on stale catalog sources
  for (const source of ['models.dev', 'modelbench', 'zeroeval'] as const) {
    try {
      await ensureFresh(source);
    } catch (err) {
      logger.warn('Boot catalog sync failed (continuing with stale data)', { source, err: err instanceof Error ? err.message : String(err) });
    }
  }
  startCatalogCron(logger);

  const app = express();
  const corsOrigins = allowedOrigins.length
    ? allowedOrigins
    : ['http://localhost:4000', 'http://127.0.0.1:4000'];

  // ── Correlation ID ──────────────────────────────────────────────────────
  app.use((req, _res, next) => {
    (req as AuthedRequest).correlationId = (req.headers['x-request-id'] as string) ?? crypto.randomUUID();
    (req as AuthedRequest).clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? '';
    next();
  });

  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        imgSrc: ["'self'", 'data:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '5mb' }));

  // ── Health check (rate-limited, public) ──────────────────────────────────
  const healthLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Too many requests' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.get('/health', healthLimiter, async (_req, res) => {
    let dbOk = false;
    try {
      if (getDriver() === 'postgres') {
        const { getPgPool } = await import('../db/postgres.js');
        await getPgPool().query('SELECT 1');
        dbOk = true;
      } else {
        getDb().prepare('SELECT 1').get();
        dbOk = true;
      }
    } catch { /* db not ready */ }
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'healthy' : 'degraded',
      uptime: process.uptime(),
      db: dbOk ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    });
  });

  // ── Prometheus metrics (public, unauthenticated) ─────────────────────────
  const metricsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: 'Too many requests' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.get('/metrics', metricsLimiter, async (_req, res) => {
    try {
      await metricsHandler(_req, res);
    } catch (err) {
      res.status(500).send('metrics error');
    }
  });

  // ── Global rate limiter ──────────────────────────────────────────────────
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    message: { error: 'Too many requests' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', apiLimiter);

  loadApiKeysConfig(path.join(root, 'configs', 'api-keys.yaml'), logger);

  // ── Auth login (public) ──────────────────────────────────────────────────
  const loginRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many login attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.post('/api/auth/login', loginRateLimit, (req: AuthedRequest, res) => {
    const username = String(req.body?.username ?? '');
    const password = String(req.body?.password ?? '');
    if (!verifyCredentials(auth, username, password)) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const token = signToken(auth, username);
    // Set httpOnly cookie in addition to returning the token in the response body
    setTokenCookie(res, token, auth);
    res.json({ token, username });
  });

  // ── Auth logout (revoke token) ──────────────────────────────────────────
  app.post('/api/auth/logout', requireAuth(auth), async (req: AuthedRequest, res) => {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m?.[1]) {
      await revokeToken(m[1]);
    }
    clearTokenCookie(res);
    res.json({ ok: true });
  });

  // ── Secrets masking on all JSON responses ──────────────────────────────
  app.use((_req, res, next) => {
    const orig = res.json.bind(res) as (body: unknown) => ReturnType<typeof res.json>;
    res.json = (body: unknown) => orig(maskSecrets(body));
    next();
  });

  // ── Authenticated API routers (JWT + RBAC) ─────────────────────────────
  app.use('/api/models', requireAuth(auth), requireRole('viewer'), createModelsRouter());
  app.use('/api/scenarios', requireAuth(auth), requireRole('viewer'), createScenariosRouter());
  app.use('/api/runs', requireAuth(auth), requireRole('viewer'), createRunsRouter());
  app.use('/api/traces', requireAuth(auth), requireRole('viewer'), createTracesRouter());
  app.use('/api/anomalies', requireAuth(auth), requireRole('viewer'), createAnomaliesRouter());
  app.use('/api/observability', requireAuth(auth), requireRole('viewer'), createObservabilityRouter());
  app.use('/api/webhooks', requireAuth(auth), requireRole('admin'), createWebhooksRouter());
  app.use('/api/providers', requireAuth(auth), requireRole('admin'), createProvidersRouter());
  app.use('/api/secrets', requireAuth(auth), requireRole('admin'), createSecretsRouter());
  app.use('/api/catalog', requireAuth(auth), requireRole('viewer'), createCatalogRouter());
  app.use('/api/metrics', requireAuth(auth), requireRole('viewer'), createMetricsRouter());
  app.use('/api/cache', requireAuth(auth), requireRole('viewer'), createCacheRouter());
  app.use('/api/analytics', requireAuth(auth), requireRole('viewer'), createAnalyticsRouter());
  app.use('/api/export', requireAuth(auth), requireRole('viewer'), createExportRouter());

  // ── Prompts (viewer for reads, admin for writes; enqueue is editor) ────
  app.use('/api/prompts', requireAuth(auth), requireRole('viewer'), createPromptsRouter());

  // ── Output mappings (viewer for reads, admin for writes) ──────────────
  app.use('/api/output-mappings', requireAuth(auth), requireRole('viewer'), createOutputMappingsRouter());

  // ── Sessions (viewer for reads, admin for deletes) ────────────────────
  app.use('/api/sessions', requireAuth(auth), requireRole('viewer'), createSessionsRouter());

  // ── User management (admin only) ──────────────────────────────────────
  app.use('/api/users', requireAuth(auth), requireRole('admin'), createUsersRouter());
  app.get('/api/roles', requireAuth(auth), requireRole('viewer'), (_req, res) => {
    const roles = getDb().prepare('SELECT * FROM roles ORDER BY id').all();
    res.json({ roles });
  });

  // ── Audit log (admin only) ────────────────────────────────────────────
  app.use('/api/audit', requireAuth(auth), requireRole('admin'), createAuditRouter());

  // ── Cost ledger (viewer for reads) ────────────────────────────────────
  app.use('/api/cost', requireAuth(auth), requireRole('viewer'), createCostRouter());

  // ── Files listing (viewer for reads) ─────────────────────────────────
  app.use('/api/files', requireAuth(auth), requireRole('viewer'), createFilesRouter());

  // ── Budget & scheduling & regression (new) ─────────────────────────────
  app.use('/api/budget', requireAuth(auth), requireRole('viewer'), createBudgetRouter());
  app.use('/api/schedules', requireAuth(auth), requireRole('viewer'), createSchedulesRouter());
  app.use('/api/regression', requireAuth(auth), requireRole('viewer'), createRegressionRouter());

  // ── Runner management (k8s API, admin only) ──────────────────────────────
  registerRunnerRoutes(app, requireAuth(auth));

  // ── Queue & DLQ routes (admin only) ───────────────────────────────────────
  registerQueueRoutes(app, requireAuth(auth));
  const { activateKillSwitch, deactivateKillSwitch, isKillSwitchActive } = await import('../orchestrator/run-lifecycle.js');
  app.post('/api/ops/killswitch', requireAuth(auth), requireRole('admin'), (_req, res) => {
    activateKillSwitch();
    res.json({ active: true });
  });
  app.delete('/api/ops/killswitch', requireAuth(auth), requireRole('admin'), (_req, res) => {
    deactivateKillSwitch();
    res.json({ active: false });
  });
  app.get('/api/ops/killswitch', requireAuth(auth), requireRole('admin'), (_req, res) => {
    res.json({ active: isKillSwitchActive() });
  });

  // ── Public API (API key auth + rate limiting), versioned under /api/v1 ────────
  app.use('/api/v1/models', requireApiKey(['models:read']), createModelsRouter());
  app.use('/api/v1/scenarios', requireApiKey(['scenarios:read']), createScenariosRouter());
  app.use('/api/v1/runs', requireApiKey(['runs:read']), createRunsRouter());
  app.use('/api/v1/analytics', requireApiKey(['analytics:read']), createAnalyticsRouter());
  app.use('/api/v1/export', requireApiKey(['export:read']), createExportRouter());
  app.use('/api/v1/traces', requireApiKey(['traces:read']), createTracesRouter());
  app.use('/api/v1/anomalies', requireApiKey(['anomalies:read']), createAnomaliesRouter());
  app.use('/api/v1/observability', requireApiKey(['observability:read']), createObservabilityRouter());
  app.use('/api/v1/webhooks', requireApiKey(['webhooks:write']), createWebhooksRouter());
  app.use('/api/v1/providers', requireApiKey(['providers:read']), createProvidersRouter());
  app.use('/api/v1/catalog', requireApiKey(['catalog:read']), createCatalogRouter());
  app.use('/api/v1/metrics', requireApiKey(['metrics:read']), createMetricsRouter());
  app.use('/api/v1/cache', requireApiKey(['cache:read']), createCacheRouter());

  // ── v1 for newly added modules ──────────────────────────────────────────
  app.use('/api/v1/budget', requireApiKey(['budget:read']), createBudgetRouter());
  app.use('/api/v1/schedules', requireApiKey(['schedules:read']), createSchedulesRouter());
  app.use('/api/v1/regression', requireApiKey(['regression:execute']), createRegressionRouter());
  app.use('/api/v1/cost', requireApiKey(['cost:read']), createCostRouter());
  app.use('/api/v1/files', requireApiKey(['files:read']), createFilesRouter());
  app.use('/api/v1/sessions', requireApiKey(['sessions:read']), createSessionsRouter());
  app.use('/api/v1/prompts', requireApiKey(['prompts:read']), createPromptsRouter());
  app.use('/api/v1/output-mappings', requireApiKey(['output_mappings:read']), createOutputMappingsRouter());

  // ── OpenAPI interactive docs (authenticated) ──────────────────────────────
  mountOpenApi(app, requireAuth(auth));

  // ── Global error handler (must be last in the middleware chain) ─────────
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled route error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  });

  // ── Serve the built frontend in production (SPA) ─────────────────────────
  const dist = clientDist();
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get(/^(?!\/api|\/ws).*/, (_req, res) => {
      res.sendFile(path.join(dist, 'index.html'));
    });
    logger.info('Serving built dashboard client', { dist });
  } else {
    logger.warn('Dashboard client not built (src/dashboard-client/dist missing). Use "npm run dashboard:dev" for the Vite dev server, or "npm run dashboard:build".');
    app.get('/', (_req, res) => {
      res.type('text/plain').send('ai-model-arena dashboard API is running. Build the client with `npm run dashboard:build` or run `npm run dashboard:dev`.');
    });
  }

  const server = http.createServer(app);
  // Session-scoped stream WebSocket (runner ↔ dashboard relay)
  attachStreamWs(server);
  // WebSocket gateway (auth via token in Sec-WebSocket-Protocol).
  const hub = new LiveHub(server, auth);

  server.listen(port, () => {
    logger.info(`Dashboard running at http://localhost:${port}`);
    logger.info(`WebSocket at ws://localhost:${port}/ws`);
  });

  const shutdown = (): void => {
    logger.info('Shutting down dashboard server...');
    hub.close();
    stopCatalogCron();
    server.close(() => {
      logger.info('Server closed cleanly');
      try { void closeDb(); } catch { /* ignore */ }
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => {
      logger.warn('Graceful shutdown timed out after 10 s — forcing exit');
      try { void closeDb(); } catch { /* ignore */ }
      process.exit(1);
    }, 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { error: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

start().catch((err) => {
  logger.error('Dashboard server failed to start', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
