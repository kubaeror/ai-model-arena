import crypto from 'node:crypto';
import { getRunById } from '../db/query.js';
import { getMaxTurnForSession } from '../db/query.js';

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

export async function isTaskCompleted(taskId: string): Promise<boolean> {
  const row = await getRunById(taskId);
  return row?.status === 'completed';
}

export async function resumeFromTurn(sessionId: string): Promise<number> {
  return getMaxTurnForSession(sessionId);
}
