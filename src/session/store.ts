import crypto from 'node:crypto';
import { getDb } from '../db/client.js';

export type SessionStatus = 'active' | 'completed' | 'errored';

export interface Session {
  id: string;
  promptId: string | null;
  promptVersion: number | null;
  model: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  turn: number;
  role: string;
  content: string | null;
  toolCalls: string | null;
  toolCallId: string | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  createdAt: string;
}

export interface ModelCallRecord {
  sessionId: string;
  turn: number;
  provider: string;
  model: string;
  requestHash: string;
  responseText: string | null;
  usage: Record<string, unknown> | null;
  latencyMs: number | null;
}

export interface SessionStore {
  createSession(opts: { promptId?: string; promptVersion?: number; model: string }): Promise<Session>;
  loadSession(sessionId: string): Promise<Session | null>;
  appendMessage(sessionId: string, msg: StoredMessage): Promise<void>;
  listMessages(sessionId: string): Promise<StoredMessage[]>;
  recordModelCall(call: ModelCallRecord): Promise<void>;
  getModelCall(sessionId: string, turn: number): Promise<ModelCallRecord | null>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
}

class SqliteSessionStore implements SessionStore {
  async createSession(opts: { promptId?: string; promptVersion?: number; model: string }): Promise<Session> {
    const db = getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO sessions (id, prompt_id, prompt_version, model, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)`).run(
      id, opts.promptId ?? null, opts.promptVersion ?? null, opts.model, now, now,
    );
    return { id, promptId: opts.promptId ?? null, promptVersion: opts.promptVersion ?? null, model: opts.model, status: 'active', createdAt: now, updatedAt: now };
  }

  async loadSession(sessionId: string): Promise<Session | null> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      promptId: row.prompt_id ? String(row.prompt_id) : null,
      promptVersion: row.prompt_version != null ? Number(row.prompt_version) : null,
      model: row.model ? String(row.model) : null,
      status: String(row.status) as SessionStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async appendMessage(sessionId: string, msg: StoredMessage): Promise<void> {
    getDb().prepare(`INSERT INTO messages (id, session_id, turn, role, content, tool_calls, tool_call_id, token_input, token_output, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      msg.id, sessionId, msg.turn, msg.role, msg.content, msg.toolCalls, msg.toolCallId, msg.tokenInput, msg.tokenOutput, msg.createdAt,
    );
  }

  async listMessages(sessionId: string): Promise<StoredMessage[]> {
    const rows = getDb().prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY turn, created_at').all(sessionId) as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      sessionId: String(r.session_id),
      turn: Number(r.turn),
      role: String(r.role),
      content: r.content ? String(r.content) : null,
      toolCalls: r.tool_calls ? String(r.tool_calls) : null,
      toolCallId: r.tool_call_id ? String(r.tool_call_id) : null,
      tokenInput: r.token_input != null ? Number(r.token_input) : null,
      tokenOutput: r.token_output != null ? Number(r.token_output) : null,
      createdAt: String(r.created_at),
    }));
  }

  async recordModelCall(call: ModelCallRecord): Promise<void> {
    const db = getDb();
    db.prepare(`INSERT INTO model_calls (id, session_id, turn, provider, model, request_hash, response_text, usage, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, turn) DO UPDATE SET response_text=excluded.response_text, usage=excluded.usage, latency_ms=excluded.latency_ms, created_at=excluded.created_at`).run(
      crypto.randomUUID(), call.sessionId, call.turn, call.provider, call.model, call.requestHash,
      call.responseText, call.usage ? JSON.stringify(call.usage) : null, call.latencyMs, new Date().toISOString(),
    );
  }

  async getModelCall(sessionId: string, turn: number): Promise<ModelCallRecord | null> {
    const row = getDb().prepare('SELECT * FROM model_calls WHERE session_id = ? AND turn = ?').get(sessionId, turn) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sessionId: String(row.session_id),
      turn: Number(row.turn),
      provider: String(row.provider),
      model: String(row.model),
      requestHash: String(row.request_hash),
      responseText: row.response_text ? String(row.response_text) : null,
      usage: row.usage ? JSON.parse(String(row.usage)) : null,
      latencyMs: row.latency_ms != null ? Number(row.latency_ms) : null,
    };
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
    getDb().prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), sessionId);
  }
}

export function createSessionStore(): SessionStore {
  return new SqliteSessionStore();
}
