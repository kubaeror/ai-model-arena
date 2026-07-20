import 'dotenv/config';
import '../env.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { findProjectRoot } from '../paths.js';
import { createLogger } from '../logger/pino-logger.js';
import { initDb } from '../db/client.js';
import { ensureFresh } from '../catalog/cache.js';
import { startCatalogCron } from '../catalog/cron.js';
import { loadAuthConfig, requireAuth, verifyCredentials, signToken, type AuthedRequest } from './auth.js';
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
import { mountOpenApi } from './openapi.js';

const logger = createLogger('ai-arena:dashboard');

function clientDist(): string {
  return path.join(findProjectRoot(), 'src', 'dashboard-client', 'dist');
}

async function start(): Promise<void> {
  const port = Number(process.env.DASHBOARD_PORT ?? 4000);
  const auth = loadAuthConfig();
  if (auth.generatedPassword) {
    logger.warn('No DASHBOARD_PASSWORD set — generated a one-time password', {
      generatedPassword: auth.generatedPassword,
    });
  }
  const root = findProjectRoot();
  const allowedOrigins = (process.env.DASHBOARD_CORS_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const dbPath = path.join(root, 'outputs', 'arena.db');
  initDb(dbPath);
  logger.info('SQLite catalog DB initialized', { dbPath });

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
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        imgSrc: ["'self'", 'data:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '20mb' }));

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
    res.json({ token: signToken(auth, username), username });
  });

  // ── Authenticated API routers (JWT) ─────────────────────────────────────────
  app.use('/api/models', requireAuth(auth), createModelsRouter());
  app.use('/api/scenarios', requireAuth(auth), createScenariosRouter());
  app.use('/api/runs', requireAuth(auth), createRunsRouter());
  app.use('/api/traces', requireAuth(auth), createTracesRouter());
  app.use('/api/anomalies', requireAuth(auth), createAnomaliesRouter());
  app.use('/api/observability', requireAuth(auth), createObservabilityRouter());
  app.use('/api/webhooks', requireAuth(auth), createWebhooksRouter());
  app.use('/api/providers', requireAuth(auth), createProvidersRouter());

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

  // ── Public API (API key auth) ──────────────────────────────────────────────
  app.use('/api/analytics', requireApiKey(['analytics:read']), createAnalyticsRouter());
  app.use('/api/export', requireApiKey(['export:read']), createExportRouter());

  // ── OpenAPI interactive docs (public) ──────────────────────────────────────
  mountOpenApi(app);

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
  // WebSocket gateway (auth via ?token= query).
  const hub = new LiveHub(server, auth);

  server.listen(port, () => {
    logger.info(`Dashboard running at http://localhost:${port}`);
    logger.info(`WebSocket at ws://localhost:${port}/ws`);
  });

  const shutdown = (): void => {
    logger.info('Shutting down dashboard server...');
    hub.close();
    server.close(() => {
      logger.info('Server closed cleanly');
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => {
      logger.warn('Graceful shutdown timed out after 10 s — forcing exit');
      process.exit(1);
    }, 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err) => {
  logger.error('Dashboard server failed to start', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
