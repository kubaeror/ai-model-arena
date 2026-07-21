import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import type { Role, ToolCall, TokenUsage } from '../types.js';

export type ConversationEntryType =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'info'
  | 'error';

export interface ConversationEntry {
  timestamp: string;
  type: ConversationEntryType;
  turn?: number;
  role?: Role;
  content?: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  toolResult?: string;
  isError?: boolean;
  usage?: TokenUsage;
  stopReason?: string;
  meta?: Record<string, unknown>;
}

export interface ConversationFile {
  model: string;
  scenario: string;
  runId: string;
  startedAt: string;
  endedAt?: string;
  entries: ConversationEntry[];
}

export interface ConversationDbSink {
  appendMessage(sessionId: string, msg: {
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
  }): Promise<void>;
}

/**
 * Writes a structured, durable conversation transcript to `conversation.json`.
 * Each `append()` flushes the whole file so a crash mid-run still leaves a
 * usable partial transcript.
 */
export class ConversationLogger {
  private file: ConversationFile;
  private dbSink?: ConversationDbSink;
  private sessionId?: string;
  private turn = 0;
  private disableFile = false;

  constructor(
    private readonly filePath: string,
    meta: { model: string; scenario: string; runId: string; startedAt: string },
    opts?: { dbSink?: ConversationDbSink; sessionId?: string; disableFile?: boolean },
  ) {
    this.file = { ...meta, entries: [] };
    this.dbSink = opts?.dbSink;
    this.sessionId = opts?.sessionId;
    this.disableFile = opts?.disableFile ?? false;
  }

  append(entry: Omit<ConversationEntry, 'timestamp'> & { timestamp?: string }): void {
    const { timestamp, ...rest } = entry;
    const e: ConversationEntry = {
      ...rest,
      timestamp: timestamp ?? new Date().toISOString(),
    };
    this.file.entries.push(e);
    if (entry.turn != null) this.turn = entry.turn;

    if (this.dbSink && this.sessionId && entry.role) {
      const msg = {
        id: crypto.randomUUID(),
        sessionId: this.sessionId,
        turn: entry.turn ?? this.turn,
        role: entry.role,
        content: entry.content ?? null,
        toolCalls: entry.toolCalls ? JSON.stringify(entry.toolCalls) : null,
        toolCallId: entry.toolCallId ?? null,
        tokenInput: entry.usage?.prompt ?? null,
        tokenOutput: entry.usage?.completion ?? null,
        createdAt: entry.timestamp ?? new Date().toISOString(),
      };
      this.dbSink.appendMessage(this.sessionId, msg).catch(() => {});
    }

    this.flush();
  }

  setEnded(at: string): void {
    this.file.endedAt = at;
    this.flush();
  }

  get entries(): readonly ConversationEntry[] {
    return this.file.entries;
  }

  flush(): void {
    if (this.disableFile) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.file, null, 2));
  }
}
