import fs from 'node:fs';
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

/**
 * Writes a structured, durable conversation transcript to `conversation.json`.
 * Each `append()` flushes the whole file so a crash mid-run still leaves a
 * usable partial transcript.
 */
export class ConversationLogger {
  private file: ConversationFile;

  constructor(
    private readonly filePath: string,
    meta: { model: string; scenario: string; runId: string; startedAt: string },
  ) {
    this.file = { ...meta, entries: [] };
  }

  append(entry: Omit<ConversationEntry, 'timestamp'> & { timestamp?: string }): void {
    const { timestamp, ...rest } = entry;
    const e: ConversationEntry = {
      ...rest,
      timestamp: timestamp ?? new Date().toISOString(),
    };
    this.file.entries.push(e);
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
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.file, null, 2));
  }
}
