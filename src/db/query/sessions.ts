import { eq, and, count, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { sessions, messages, model_calls } from '../schema.js';
import type { DbSession } from '../schema.js';
import { paginate } from './dashboard.js';

// ── Sessions ──────────────────────────────────────────────────────────────

export async function createSession(data: {
  id: string; promptId?: string | null; promptVersion?: number | null;
  model: string; status?: string; createdAt: string; updatedAt: string;
}): Promise<DbSession> {
  const db = getDrizzleDb();
  await db.insert(sessions).values({
    id: data.id,
    prompt_id: data.promptId ?? null,
    prompt_version: data.promptVersion ?? null,
    model: data.model,
    status: data.status ?? 'active',
    created_at: data.createdAt,
    updated_at: data.updatedAt,
  });
  return { id: data.id, prompt_id: data.promptId ?? null, prompt_version: data.promptVersion ?? null, model: data.model, status: data.status ?? 'active', created_at: data.createdAt, updated_at: data.updatedAt };
}

export async function getSessionById(id: string): Promise<DbSession | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateSessionStatus(id: string, status: string): Promise<void> {
  const db = getDrizzleDb();
  await db.update(sessions).set({ status, updated_at: new Date().toISOString() }).where(eq(sessions.id, id));
}

// ── Dashboard: sessions helpers ───────────────────────────────────────────

export interface SessionWithCountsRow {
  id: string; model: string; status: string;
  created_at: string; updated_at: string;
  message_count: number; call_count: number;
}

export async function listSessionsWithCounts(opts: {
  status?: string; model?: string; limit: number; offset: number;
}): Promise<{ sessions: SessionWithCountsRow[]; total: number }> {
  const db = getDrizzleDb();
  const conds: SQL[] = [];
  if (opts.status) conds.push(eq(sessions.status, opts.status));
  if (opts.model) conds.push(eq(sessions.model, opts.model));
  const where = conds.length ? and(...conds) : undefined;

  const { rows, total } = await paginate(sessions, {
    id: sessions.id,
    model: sessions.model,
    status: sessions.status,
    created_at: sessions.created_at,
    updated_at: sessions.updated_at,
  }, {
    orderBy: 'created_at',
    dir: 'desc',
    pageSize: opts.limit,
    offset: opts.offset,
    where,
  });

  const ids = (rows as Array<{ id: string }>).map(r => r.id);
  const msgCounts = new Map<string, number>();
  const callCounts = new Map<string, number>();
  if (ids.length > 0) {
    const msgRows = await db.select({ sessionId: messages.session_id, c: count() })
      .from(messages).where(inArray(messages.session_id, ids)).groupBy(messages.session_id);
    const callRows = await db.select({ sessionId: model_calls.session_id, c: count() })
      .from(model_calls).where(inArray(model_calls.session_id, ids)).groupBy(model_calls.session_id);
    for (const g of msgRows) msgCounts.set(String(g.sessionId), Number(g.c));
    for (const g of callRows) callCounts.set(String(g.sessionId), Number(g.c));
  }

  const result = (rows as Array<{ id: string }>).map(r => ({
    ...r,
    message_count: msgCounts.get(r.id) ?? 0,
    call_count: callCounts.get(r.id) ?? 0,
  } as SessionWithCountsRow));
  return { sessions: result, total };
}

export async function getSessionWithCounts(sessionId: string): Promise<SessionWithCountsRow | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!rows[0]) return null;
  const [msgCount, callCount] = await Promise.all([
    db.select({ c: count() }).from(messages).where(eq(messages.session_id, sessionId)),
    db.select({ c: count() }).from(model_calls).where(eq(model_calls.session_id, sessionId)),
  ]);
  return {
    ...rows[0],
    message_count: Number(msgCount[0]?.c ?? 0),
    call_count: Number(callCount[0]?.c ?? 0),
  };
}

export async function deleteSessionCascade(sessionId: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(model_calls).where(eq(model_calls.session_id, sessionId));
  await db.delete(messages).where(eq(messages.session_id, sessionId));
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}
