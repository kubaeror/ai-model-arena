import crypto from 'node:crypto';
import {
  createSession, getSessionById, updateSessionStatus,
  createMessage, listMessagesBySession,
  upsertModelCall, getModelCallBySessionAndTurn,
} from '../db/query.js';

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
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await createSession({
      id, promptId: opts.promptId ?? null, promptVersion: opts.promptVersion ?? null,
      model: opts.model, status: 'active', createdAt: now, updatedAt: now,
    });
    return { id, promptId: opts.promptId ?? null, promptVersion: opts.promptVersion ?? null, model: opts.model, status: 'active', createdAt: now, updatedAt: now };
  }

  async loadSession(sessionId: string): Promise<Session | null> {
    const row = await getSessionById(sessionId);
    if (!row) return null;
    return {
      id: row.id,
      promptId: row.prompt_id ?? null,
      promptVersion: row.prompt_version ?? null,
      model: row.model ?? null,
      status: row.status as SessionStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async appendMessage(sessionId: string, msg: StoredMessage): Promise<void> {
    await createMessage({
      id: msg.id, sessionId, turn: msg.turn, role: msg.role,
      content: msg.content, toolCalls: msg.toolCalls, toolCallId: msg.toolCallId,
      tokenInput: msg.tokenInput, tokenOutput: msg.tokenOutput, createdAt: msg.createdAt,
    });
  }

  async listMessages(sessionId: string): Promise<StoredMessage[]> {
    const rows = await listMessagesBySession(sessionId);
    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      turn: r.turn,
      role: r.role,
      content: r.content ?? null,
      toolCalls: r.tool_calls ?? null,
      toolCallId: r.tool_call_id ?? null,
      tokenInput: r.token_input ?? null,
      tokenOutput: r.token_output ?? null,
      createdAt: r.created_at,
    }));
  }

  async recordModelCall(call: ModelCallRecord): Promise<void> {
    await upsertModelCall({
      id: crypto.randomUUID(), sessionId: call.sessionId, turn: call.turn,
      provider: call.provider, model: call.model, requestHash: call.requestHash,
      responseText: call.responseText, usage: call.usage ? JSON.stringify(call.usage) : null,
      latencyMs: call.latencyMs, createdAt: new Date().toISOString(),
    });
  }

  async getModelCall(sessionId: string, turn: number): Promise<ModelCallRecord | null> {
    const row = await getModelCallBySessionAndTurn(sessionId, turn);
    if (!row) return null;
    return {
      sessionId: row.session_id,
      turn: row.turn,
      provider: row.provider,
      model: row.model,
      requestHash: row.request_hash,
      responseText: row.response_text ?? null,
      usage: row.usage ? JSON.parse(row.usage) : null,
      latencyMs: row.latency_ms ?? null,
    };
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
    await updateSessionStatus(sessionId, status);
  }
}

export function createSessionStore(): SessionStore {
  return new SqliteSessionStore();
}
