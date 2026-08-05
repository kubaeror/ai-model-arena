import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { closeDb, initDb } from '../../src/db/index.js';
import { assignUserRole, countRoles, getUserByUsername, insertRole, insertUser } from '../../src/db/query.js';
import { maskSecrets } from '../../src/dashboard-server/secrets.js';
import {
  loadAuthConfig,
  requireAuth,
  setTokenCookie,
  signToken,
  verifyCredentials,
} from '../../src/dashboard-server/auth.js';
import { requireRole } from '../../src/auth/rbac.js';

export interface TestUser {
  username: string;
  password: string;
  role: 'viewer' | 'editor' | 'admin';
}

export const TEST_ADMIN: TestUser = { username: 'tester', password: 'test-pass-123', role: 'admin' };
export const TEST_VIEWER: TestUser = { username: 'viewer1', password: 'viewer-pass-123', role: 'viewer' };

const ENV_KEYS = [
  'ARENA_DB_PATH',
  'OUTPUT_ROOT',
  'DASHBOARD_USERNAME',
  'DASHBOARD_PASSWORD',
  'DASHBOARD_JWT_SECRET',
  'DASHBOARD_REDIS_URL',
  'QUEUE_DRIVER',
] as const;

export async function login(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(`login failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

export async function authedGet(base: string, token: string, pathname: string): Promise<Response> {
  return fetch(`${base}${pathname}`, { headers: { authorization: `Bearer ${token}` } });
}

export async function postJson(base: string, token: string | null, pathname: string, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function seedRolesAndUsers(extraUser?: TestUser): Promise<void> {
  if ((await countRoles()) === 0) {
    await insertRole({ id: 'viewer', description: 'Read-only access to dashboards, runs, and results' });
    await insertRole({ id: 'editor', description: 'Can create and manage runs, but not system configuration' });
    await insertRole({ id: 'admin', description: 'Full system access including providers, secrets, and user management' });
  }
  const argon2 = await import('argon2');
  for (const u of [TEST_ADMIN, ...(extraUser ? [extraUser] : [])]) {
    if (await getUserByUsername(u.username)) continue;
    const id = crypto.randomUUID();
    await insertUser({
      id,
      username: u.username,
      passwordHash: await argon2.hash(u.password, { type: argon2.argon2id }),
      createdAt: new Date().toISOString(),
    });
    await assignUserRole(id, u.role);
  }
}

export interface BootOptions {
  seedViewerUser?: boolean;
}

export interface ArenaHarness {
  base: string;
  adminToken: string;
  viewerToken?: string;
  tmpDir: string;
  close(): Promise<void>;
}

export async function boot(t: TestContext, options: BootOptions = {}): Promise<ArenaHarness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-routes-'));
  const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

  process.env.AI_ARENA_ROOT = dir;
  process.env.ARENA_DB_PATH = path.join(dir, 'arena.db');
  process.env.OUTPUT_ROOT = path.join(dir, 'outputs');
  process.env.DASHBOARD_JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
  process.env.DASHBOARD_USERNAME = 'admin';
  process.env.DASHBOARD_PASSWORD = 'admin-pass-123';
  delete process.env.DASHBOARD_REDIS_URL;
  delete process.env.QUEUE_DRIVER;

  initDb(path.join(dir, 'arena.db'));
  await seedRolesAndUsers(options.seedViewerUser ? TEST_VIEWER : undefined);

  const auth = loadAuthConfig();
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/api/auth/login', async (req, res) => {
    const username = String(req.body?.username ?? '');
    const password = String(req.body?.password ?? '');
    if (verifyCredentials(auth, username, password)) {
      const token = signToken(auth, username, 'admin');
      setTokenCookie(res, token, auth);
      res.json({ token, username, role: 'admin' });
      return;
    }
    try {
      const { getUserRolesByUserId } = await import('../../src/db/query.js');
      const user = await getUserByUsername(username);
      if (user) {
        const argon2 = await import('argon2');
        if (await argon2.verify(user.password_hash, password)) {
          const roleRows = (await getUserRolesByUserId(user.id)) as Array<{ id: string }>;
          const roles = roleRows.map((r) => r.id);
          const role = roles.includes('admin') ? 'admin' : roles.includes('editor') ? 'editor' : 'viewer';
          const token = signToken(auth, username, role);
          setTokenCookie(res, token, auth);
          res.json({ token, username, role });
          return;
        }
      }
    } catch {
      /* fall through to 401 */
    }
    res.status(401).json({ error: 'Invalid credentials' });
  });

  app.use((_req, res, next) => {
    const orig = res.json.bind(res) as (body: unknown) => ReturnType<typeof res.json>;
    res.json = (body: unknown) => orig(maskSecrets(body));
    next();
  });

  const bust = `?bust=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { createModelsRouter } = await import(`../../src/dashboard-server/routes/models.js${bust}`);
  const { createScenariosRouter } = await import(`../../src/dashboard-server/routes/scenarios.js${bust}`);
  const { createRunsRouter } = await import(`../../src/dashboard-server/routes/runs.js${bust}`);
  const { createSecretsRouter } = await import(`../../src/dashboard-server/routes/secrets.js${bust}`);
  const { createAuditRouter } = await import(`../../src/dashboard-server/routes/audit.js${bust}`);
  const { registerQueueRoutes } = await import(`../../src/dashboard-server/routes/queues.js${bust}`);

  app.use('/api/models', requireAuth(auth), requireRole('viewer'), createModelsRouter());
  app.use('/api/scenarios', requireAuth(auth), requireRole('viewer'), createScenariosRouter());
  app.use('/api/runs', requireAuth(auth), requireRole('viewer'), createRunsRouter());
  app.use('/api/secrets', requireAuth(auth), requireRole('admin'), createSecretsRouter());
  app.use('/api/audit', requireAuth(auth), requireRole('admin'), createAuditRouter());
  app.get('/api/roles', requireAuth(auth), requireRole('viewer'), async (_req, res) => {
    const { listRoles } = await import('../../src/db/query.js');
    res.json({ roles: await listRoles() });
  });
  registerQueueRoutes(app, requireAuth(auth));

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const adminToken = await login(base, TEST_ADMIN.username, TEST_ADMIN.password);
  const viewerToken = options.seedViewerUser ? await login(base, TEST_VIEWER.username, TEST_VIEWER.password) : undefined;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    server.close();
    server.closeIdleConnections();
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  t.after(() => void close());

  return { base, adminToken, viewerToken, tmpDir: dir, close };
}
