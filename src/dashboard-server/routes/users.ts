import { Router } from 'express';
import crypto from 'node:crypto';
import { auditSafe } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import { z } from 'zod';
import {
  getUserById, getUserByUsername, listUsersWithRoles,
  insertUser, updateUser, deleteUserById,
  getUserRolesByUserId, assignUserRole, unassignUserRole,
  countUserRoles, listRoles, insertRole, countRoles,
} from '../../db/query.js';
import { hashPassword } from '../../auth/password.js';
import { notFound, parseBody } from '../helpers.js';

function now(): string {
  return new Date().toISOString();
}

async function seedDefaultRoles(): Promise<void> {
  const cnt = await countRoles();
  if (cnt > 0) return;

  await insertRole({ id: 'viewer', description: 'Read-only access to dashboards, runs, and results' });
  await insertRole({ id: 'editor', description: 'Can create and manage runs, but not system configuration' });
  await insertRole({ id: 'admin', description: 'Full system access including providers, secrets, and user management' });
}

async function seedDefaultAdmin(): Promise<void> {
  const rows = await listUsersWithRoles();
  if (rows.length > 0) return;

  const username = process.env.DASHBOARD_USERNAME ?? 'admin';
  const password = process.env.DASHBOARD_PASSWORD ?? crypto.randomBytes(12).toString('base64url');
  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  const timestamp = now();

  await insertUser({ id, username, passwordHash: hash, createdAt: timestamp });
  await assignUserRole(id, 'admin');
}

export function createUsersRouter(): Router {
  const router = Router();

  // Seed default roles + admin user on first router creation (idempotent)
  void (async () => {
    await seedDefaultRoles();
    await seedDefaultAdmin();
  })();

  // GET /api/users - list all users with roles
  router.get('/', async (_req, res) => {
    const rows = await listUsersWithRoles();
    const users = rows.map((r: { id: string; username: string; created_at: string; roles: string | null }) => ({
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
    const parsed = parseBody(schema, req, res, 'Invalid user input');
    if (!parsed) return;

    const dup = await getUserByUsername(parsed.username);
    if (dup) {
      res.status(409).json({ error: 'Username already exists' });
      return;
    }

    const id = crypto.randomUUID();
    const hash = await hashPassword(parsed.password);
    const timestamp = now();

    await insertUser({ id, username: parsed.username, passwordHash: hash, createdAt: timestamp });

    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'user.create', { type: 'user', id }, undefined, { username: parsed.username });
    res.status(201).json({ id, username: parsed.username, created_at: timestamp, roles: [] });
  });

  // PUT /api/users/:id - update username or password
  router.put('/:id', async (req, res) => {
    const schema = z.object({
      username: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional(),
      password: z.string().min(8).max(128).optional(),
    });
    const parsed = parseBody(schema, req, res, 'Invalid input');
    if (!parsed) return;

    const existing = await getUserById(req.params.id);
    if (!existing) {
      notFound(res, 'User', req.params.id);
      return;
    }

    if (parsed.username !== undefined) {
      const dup = await getUserByUsername(parsed.username);
      if (dup && dup.id !== req.params.id) {
        res.status(409).json({ error: 'Username already exists' });
        return;
      }
      await updateUser(req.params.id, { username: parsed.username });
    }

    if (parsed.password !== undefined) {
      const hash = await hashPassword(parsed.password);
      await updateUser(req.params.id, { passwordHash: hash });
    }

    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'user.update', { type: 'user', id: req.params.id }, { username: existing.username }, parsed);
    res.json({ ok: true });
  });

  // DELETE /api/users/:id - delete user + role assignments
  router.delete('/:id', async (req, res) => {
    const existing = await getUserById(req.params.id);
    if (!existing) {
      notFound(res, 'User', req.params.id);
      return;
    }

    // Prevent deleting the last admin
    const adminCount = await countUserRoles('admin');
    const isLastAdmin = await countUserRoles('admin', req.params.id);
    if (isLastAdmin > 0 && adminCount <= 1) {
      res.status(400).json({ error: 'Cannot delete the last admin user' });
      return;
    }

    await deleteUserById(req.params.id);

    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'user.delete', { type: 'user', id: req.params.id });
    res.json({ ok: true });
  });

  // GET /api/users/roles - list all available roles
  // Registered BEFORE /:id/roles — Express matches in order, so a bare
  // "roles" segment used to be swallowed by the :id param (always 404).
  router.get('/roles', async (_req, res) => {
    const roles = await listRoles();
    res.json({ roles });
  });

  // GET /api/users/:id/roles - list roles for a user
  router.get('/:id/roles', async (req, res) => {
    const user = await getUserById(req.params.id);
    if (!user) {
      notFound(res, 'User', req.params.id);
      return;
    }
    const roles = await getUserRolesByUserId(req.params.id);
    res.json({ roles });
  });

  // POST /api/users/:id/roles - assign a role
  router.post('/:id/roles', async (req, res) => {
    const schema = z.object({ roleId: z.string().min(1).max(64) });
    const parsed = parseBody(schema, req, res, 'Invalid role input');
    if (!parsed) return;

    const user = await getUserById(req.params.id);
    if (!user) {
      notFound(res, 'User', req.params.id);
      return;
    }
    const rolesList = await listRoles();
    const role = rolesList.find(r => r.id === parsed.roleId);
    if (!role) {
      notFound(res, 'Role', parsed.roleId);
      return;
    }

    await assignUserRole(req.params.id, parsed.roleId);

    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'user.role.assign', { type: 'user', id: req.params.id }, undefined, { roleId: parsed.roleId });
    res.status(201).json({ ok: true });
  });

  // DELETE /api/users/:id/roles/:roleId - remove a role
  router.delete('/:id/roles/:roleId', async (req, res) => {
    const user = await getUserById(req.params.id);
    if (!user) {
      notFound(res, 'User', req.params.id);
      return;
    }

    // Prevent removing own admin role
    const actor = (req as AuthedRequest).user?.sub;
    if (actor === req.params.id && req.params.roleId === 'admin') {
      const adminCount = await countUserRoles('admin');
      if (adminCount <= 1) {
        res.status(400).json({ error: 'Cannot remove the last admin role' });
        return;
      }
    }

    await unassignUserRole(req.params.id, req.params.roleId);

    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'user.role.remove', { type: 'user', id: req.params.id }, undefined, { roleId: req.params.roleId });
    res.json({ ok: true });
  });

  return router;
}
