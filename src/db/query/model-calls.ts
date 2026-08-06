import { eq, and, sql } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { model_calls } from '../schema.js';
import type { DbModelCall } from '../schema.js';

// ── Model Calls ───────────────────────────────────────────────────────────

export async function upsertModelCall(data: {
  id: string; sessionId: string; turn: number; provider: string; model: string;
  requestHash: string; responseText: string | null; usage: string | null;
  latencyMs: number | null; ttftMs?: number | null; createdAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(model_calls).values({
    id: data.id, session_id: data.sessionId, turn: data.turn,
    provider: data.provider, model: data.model,
    request_hash: data.requestHash, response_text: data.responseText,
    usage: data.usage, latency_ms: data.latencyMs, ttft_ms: data.ttftMs ?? null, created_at: data.createdAt,
  }).onConflictDoUpdate({
    target: [model_calls.session_id, model_calls.turn],
    set: {
      response_text: data.responseText,
      usage: data.usage,
      latency_ms: data.latencyMs,
      // Skip ttft_ms when absent so a re-record without it doesn't clobber
      // the original first-token latency.
      ...(data.ttftMs !== undefined ? { ttft_ms: data.ttftMs } : {}),
      created_at: data.createdAt,
    },
  });
}

export async function getModelCallBySessionAndTurn(sessionId: string, turn: number): Promise<DbModelCall | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(model_calls)
    .where(and(eq(model_calls.session_id, sessionId), eq(model_calls.turn, turn)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * All model_calls belonging to a run. Sessions are keyed `${runId}-${model}`
 * (task.sessionId), so calls are found by matching the session_id prefix.
 */
export async function listModelCalls(runId: string): Promise<DbModelCall[]> {
  const db = getDrizzleDb();
  const prefix = `${runId}-`;
  return db.select().from(model_calls)
    .where(sql`substr(${model_calls.session_id}, 1, ${prefix.length}) = ${prefix}`)
    .orderBy(model_calls.created_at, model_calls.turn);
}

export async function listModelCallsForSession(sessionId: string): Promise<DbModelCall[]> {
  const db = getDrizzleDb();
  return db.select().from(model_calls).where(eq(model_calls.session_id, sessionId)).orderBy(model_calls.turn);
}
