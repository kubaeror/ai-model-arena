import { eq } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { messages } from '../schema.js';
import type { DbMessage } from '../schema.js';

// ── Messages ──────────────────────────────────────────────────────────────

export async function createMessage(data: {
  id: string; sessionId: string; turn: number; role: string;
  content: string | null; toolCalls: string | null; toolCallId: string | null;
  tokenInput: number | null; tokenOutput: number | null; createdAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(messages).values({
    id: data.id, session_id: data.sessionId, turn: data.turn, role: data.role,
    content: data.content, tool_calls: data.toolCalls, tool_call_id: data.toolCallId,
    token_input: data.tokenInput, token_output: data.tokenOutput, created_at: data.createdAt,
  });
}

export async function listMessagesBySession(sessionId: string): Promise<DbMessage[]> {
  const db = getDrizzleDb();
  return db.select().from(messages)
    .where(eq(messages.session_id, sessionId))
    .orderBy(messages.turn, messages.created_at) as any;
}
