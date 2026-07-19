import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { findProjectRoot } from '../paths.js';
import { createLogger } from '../logger/pino-logger.js';
import { loadAuthConfig, requireAuth, verifyCredentials, signToken, type AuthedRequest } from './auth.js';
import { loadApiKeysConfig, requireApiKey } from './auth-api.js';
import { LiveHub } from './live.js';
import { createModelsRouter } from './routes/models.js';
import { createScenariosRouter } from './routes/scenarios.js';
import { createRunsRouter } from './routes/runs.js';
import { createAnalyticsRouter } from './routes/analytics.js';
import { createExportRouter } from './routes/export.js';

const logger = createLogger('ai-arena:dashboard');

function clientDist(): string {
  return path.join(findProjectRoot(), 'src', 'dashboard-client', 'dist');
}

function start(): void {
  const port = Number(process.env.DASHBOARD_PORT ?? 4000);
  const auth = loadAuthConfig();
  const root = findProjectRoot();
  const allowedOrigins = (process.env.DASHBOARD_CORS_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const app = express();
  app.use(cors(allowedOrigins.length ? { origin: allowedOrigins, credentials: true } : {}));
  app.use(express.json({ limit: '20mb' }));

  loadApiKeysConfig(path.join(root, 'configs', 'api-keys.yaml'), logger);

  // ── Auth login (public) ──────────────────────────────────────────────────
  app.post('/api/auth/login', (req: AuthedRequest, res) => {
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
  
  // ── Public API (API key auth) ──────────────────────────────────────────────
  app.use('/api/analytics', requireApiKey(['analytics:read']), createAnalyticsRouter());
  app.use('/api/export', requireApiKey(['export:read']), createExportRouter());

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
    logger.info('Dashboard server listening', { port, wsPath: '/ws' });
    console.log(`\n  ai-model-arena dashboard:  http://localhost:${port}`);
    console.log(`  WebSocket:                ws://localhost:${port}/ws?token=<jwt>\n`);
  });

  const shutdown = (): void => {
    logger.info('Shutting down dashboard server...');
    hub.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
