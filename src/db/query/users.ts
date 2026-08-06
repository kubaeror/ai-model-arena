import { eq, and, count, asc, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { users, roles, user_roles } from '../schema.js';
import type { DbUser, DbRole } from '../schema.js';

// ── Users / Roles ─────────────────────────────────────────────────────────

export async function getUserByUsername(username: string): Promise<DbUser | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return rows[0] ?? null;
}

export async function getUserById(id: string): Promise<DbUser | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listRoles(): Promise<DbRole[]> {
  const db = getDrizzleDb();
  return db.select().from(roles).orderBy(roles.id);
}

export async function countRoles(): Promise<number> {
  const db = getDrizzleDb();
  const rows = await db.select({ cnt: count() }).from(roles);
  return rows[0]?.cnt ?? 0;
}

// ── Dashboard: users helpers ──────────────────────────────────────────────

export async function listUsersWithRoles(): Promise<Array<{ id: string; username: string; created_at: string; roles: string }>> {
  const db = getDrizzleDb();
  const userRows = await db.select().from(users).orderBy(asc(users.created_at));
  if (userRows.length === 0) return [];
  const roleRows = await db.select({ userId: user_roles.user_id, roleId: user_roles.role_id })
    .from(user_roles)
    .where(inArray(user_roles.user_id, userRows.map((u: { id: string }) => u.id)));
  const rolesByUser = new Map<string, string[]>();
  for (const r of roleRows) {
    const list = rolesByUser.get(r.userId) ?? [];
    list.push(r.roleId);
    rolesByUser.set(r.userId, list);
  }
  return userRows.map((u: { id: string; username: string; created_at: string }) => ({
    id: u.id,
    username: u.username,
    created_at: u.created_at,
    roles: (rolesByUser.get(u.id) ?? []).join(','),
  }));
}

export async function insertUser(data: {
  id: string; username: string; passwordHash: string; createdAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(users).values({
    id: data.id, username: data.username, password_hash: data.passwordHash,
    created_at: data.createdAt,
  });
}

export async function updateUser(id: string, data: {
  username?: string; passwordHash?: string;
}): Promise<void> {
  const db = getDrizzleDb();
  const set: Record<string, string> = {};
  if (data.username !== undefined) set.username = data.username;
  if (data.passwordHash !== undefined) set.password_hash = data.passwordHash;
  if (Object.keys(set).length === 0) return;
  await db.update(users).set(set).where(eq(users.id, id));
}

export async function deleteUserById(id: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(user_roles).where(eq(user_roles.user_id, id));
  await db.delete(users).where(eq(users.id, id));
}

export async function getUserRolesByUserId(userId: string): Promise<Array<{ id: string; description: string | null }>> {
  const db = getDrizzleDb();
  return db.select({ id: roles.id, description: roles.description })
    .from(roles)
    .innerJoin(user_roles, eq(user_roles.role_id, roles.id))
    .where(eq(user_roles.user_id, userId)) as Array<{ id: string; description: string | null }>;
}

export async function assignUserRole(userId: string, roleId: string): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(user_roles).values({ user_id: userId, role_id: roleId }).onConflictDoNothing();
}

export async function unassignUserRole(userId: string, roleId: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(user_roles).where(
    and(eq(user_roles.user_id, userId), eq(user_roles.role_id, roleId)),
  );
}

export async function countUserRoles(roleId?: string, userId?: string): Promise<number> {
  const db = getDrizzleDb();
  const conds: SQL[] = [];
  if (roleId) conds.push(eq(user_roles.role_id, roleId));
  if (userId) conds.push(eq(user_roles.user_id, userId));
  const rows = await db.select({ cnt: count() }).from(user_roles)
    .where(conds.length ? and(...conds) : undefined);
  return Number(rows[0]?.cnt ?? 0);
}

export async function insertRole(data: { id: string; description: string }): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(roles).values({ id: data.id, description: data.description }).onConflictDoNothing();
}
