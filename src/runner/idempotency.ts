import crypto from 'node:crypto';
import { getDb } from '../db/client.js';

export function configHash(config: Record<string, unknown>): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(config, Object.keys(config).sort()))
    .digest('hex');
}

export function computeTaskId(opts: {
  promptId: string;
  promptVersion: number;
  model: string;
  configHash: string;
  runId: string;
}): string {
  const input = `${opts.promptId}|${opts.promptVersion}|${opts.model}|${opts.configHash}|${opts.runId}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function isTaskCompleted(taskId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT status FROM runs WHERE run_id = ?').get(taskId) as { status: string } | undefined;
  return row?.status === 'completed';
}

export function resumeFromTurn(sessionId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT MAX(turn) as maxTurn FROM messages WHERE session_id = ?').get(sessionId) as { maxTurn: number | null } | undefined;
  return row?.maxTurn ?? -1;
}
