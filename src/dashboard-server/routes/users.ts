import { Router } from 'express';
import crypto from 'node:crypto';
import { getDb } from '../../db/client.js';
import { audit } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import { z } from 'zod';

function now(): string {
  return new Date().toISOString();
}

async function hashPassword(password: string): Promise<string> {
  const argon2 = await import('argon2');
  return argon2.hash(password, { type: argon2.argon2id });
}

async function seedDefaultRoles(): Promise<void> {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) AS cnt FROM roles').get() as { cnt: number };
  if (existing.cnt > 0) return;

  const stmt = db.prepare('INSERT OR IGNORE INTO roles (id, description) VALUES (?, ?)');
  stmt.run('viewer', 'Read-only access to dashboards, runs, and results');
  stmt.run('editor', 'Can create and manage runs, but not system configuration');
  stmt.run('admin', 'Full system access including providers, secrets, and user management');
}

async function seedDefaultAdmin(): Promise<void> {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number };
  if (existing.cnt > 0) return;

  const username = process.env.DASHBOARD_USERNAME ?? 'admin';
  const password = process.env.DASHBOARD_PASSWORD ?? crypto.randomBytes(12).toString('base64url');
  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  const timestamp = now();

  db.prepare('INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    id, username, hash, timestamp,
  );
  db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(id, 'admin');
}

export function createUsersRouter(): Router {
  const router = Router();

  // Seed default roles + admin user on first router creation (idempotent)
  void (async () => {
    await seedDefaultRoles();
    await seedDefaultAdmin();
  })();

  // GET /api/users - list all users with roles
  router.get('/', (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT u.id, u.username, u.created_at,
        GROUP_CONCAT(ur.role_id) AS roles
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at ASC
    `).all() as { id: string; username: string; created_at: string; roles: string | null }[];

    const users = rows.map((r) => ({
      id: r.id,
      username: r.username,
      created_at: r.created_at,
      roles: r.roles ? r.roles.split(',') : [],
    }));
    res.json({ users });
  });

  // POST /api/users - create new user
  router.post('/', async (req, res) => {
    const schema = z.object({
      username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'username must be alphanumeric'),
      password: z.string().min(8).max(128),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid user input', details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const dup = db.prepare('SELECT id FROM users WHERE username = ?').get(parsed.data.username);
    if (dup) {
      res.status(409).json({ error: 'Username already exists' });
      return;
    }

    const id = crypto.randomUUID();
    const hash = await hashPassword(parsed.data.password);
    const timestamp = now();

    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
      id, parsed.data.username, hash, timestamp,
    );

    audit((req as AuthedRequest).user?.sub ?? 'system', 'user.create', { type: 'user', id }, undefined, { username: parsed.data.username }).catch(() => {});
    res.status(201).json({ id, username: parsed.data.username, created_at: timestamp, roles: [] });
  });

  // PUT /api/users/:id - update username or password
  router.put('/:id', async (req, res) => {
    const schema = z.object({
      username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional(),
      password: z.string().min(8).max(128).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (parsed.data.username !== undefined) {
      const dup = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(parsed.data.username, req.params.id);
      if (dup) {
        res.status(409).json({ error: 'Username already exists' });
        return;
      }
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(parsed.data.username, req.params.id);
    }

    if (parsed.data.password !== undefined) {
      const hash = await hashPassword(parsed.data.password);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
    }

    audit((req as AuthedRequest).user?.sub ?? 'system', 'user.update', { type: 'user', id: req.params.id }, { username: (existing as Record<string, unknown>).username }, parsed.data).catch(() => {});
    res.json({ ok: true });
  });

  // DELETE /api/users/:id - delete user + role assignments
  router.delete('/:id', (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Prevent deleting the last admin
    const adminCount = db.prepare('SELECT COUNT(*) AS cnt FROM user_roles WHERE role_id = ?').get('admin') as { cnt: number };
    const isLastAdmin = db.prepare('SELECT COUNT(*) AS cnt FROM user_roles WHERE role_id = ? AND user_id = ?').get('admin', req.params.id) as { cnt: number };
    if (isLastAdmin.cnt > 0 && adminCount.cnt <= 1) {
      res.status(400).json({ error: 'Cannot delete the last admin user' });
      return;
    }

    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(req.params.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);

    audit((req as AuthedRequest).user?.sub ?? 'system', 'user.delete', { type: 'user', id: req.params.id }).catch(() => {});
    res.json({ ok: true });
  });

  // GET /api/users/:id/roles - list roles for a user
  router.get('/:id/roles', (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const roles = db.prepare('SELECT r.* FROM roles r INNER JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?').all(req.params.id);
    res.json({ roles });
  });

  // POST /api/users/:id/roles - assign a role
  router.post('/:id/roles', (req, res) => {
    const schema = z.object({ roleId: z.string().min(1).max(64) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid role input', details: parsed.error.flatten() });
      return;
    }

    const db = getDb();
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const role = db.prepare('SELECT id FROM roles WHERE id = ?').get(parsed.data.roleId);
    if (!role) {
      res.status(404).json({ error: 'Role not found' });
      return;
    }

    db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(req.params.id, parsed.data.roleId);

    audit((req as AuthedRequest).user?.sub ?? 'system', 'user.role.assign', { type: 'user', id: req.params.id }, undefined, { roleId: parsed.data.roleId }).catch(() => {});
    res.status(201).json({ ok: true });
  });

  // DELETE /api/users/:id/roles/:roleId - remove a role
  router.delete('/:id/roles/:roleId', (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Prevent removing own admin role
    const actor = (req as AuthedRequest).user?.sub;
    if (actor === req.params.id && req.params.roleId === 'admin') {
      const adminCount = db.prepare('SELECT COUNT(*) AS cnt FROM user_roles WHERE role_id = ?').get('admin') as { cnt: number };
      if (adminCount.cnt <= 1) {
        res.status(400).json({ error: 'Cannot remove the last admin role' });
        return;
      }
    }

    db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(req.params.id, req.params.roleId);

    audit((req as AuthedRequest).user?.sub ?? 'system', 'user.role.remove', { type: 'user', id: req.params.id }, undefined, { roleId: req.params.roleId }).catch(() => {});
    res.json({ ok: true });
  });

  // GET /api/roles - list all available roles
  router.get('/roles', (_req, res) => {
    const db = getDb();
    const roles = db.prepare('SELECT * FROM roles ORDER BY id').all();
    res.json({ roles });
  });

  return router;
}
