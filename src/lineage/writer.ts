import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/client.js';

export interface LineageRecord {
  id: string;
  path: string;
  runId: string;
  promptId?: string;
  promptVersion?: number;
  model: string;
  configHash?: string;
  taskId?: string;
  traceId?: string;
  producedAt: string;
  producedByTool?: string;
}

export async function writeWithLineage(
  targetAbs: string,
  content: string,
  ctx: { runId: string; model: string; taskId?: string; traceId?: string; promptId?: string; promptVersion?: number; configHash?: string; tool?: string; sandboxDir: string; },
): Promise<void> {
  const dir = path.dirname(targetAbs);
  await fs.promises.mkdir(dir, { recursive: true });

  const staging = `${targetAbs}.${process.pid}.tmp`;
  await fs.promises.writeFile(staging, content);
  await fs.promises.rename(staging, targetAbs);

  const lineage: LineageRecord = {
    id: crypto.randomUUID(),
    path: path.relative(ctx.sandboxDir, targetAbs),
    runId: ctx.runId,
    promptId: ctx.promptId,
    promptVersion: ctx.promptVersion,
    model: ctx.model,
    configHash: ctx.configHash,
    taskId: ctx.taskId,
    traceId: ctx.traceId,
    producedAt: new Date().toISOString(),
    producedByTool: ctx.tool,
  };

  await fs.promises.writeFile(`${targetAbs}.lineage.json`, JSON.stringify(lineage, null, 2));

  try {
    const db = getDb();
    db.prepare(
      'INSERT INTO files (id, run_id, path, prompt_id, prompt_version, model, config_hash, task_id, trace_id, produced_at, produced_by_tool) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      lineage.id, lineage.runId, lineage.path, lineage.promptId ?? null, lineage.promptVersion ?? null,
      lineage.model, lineage.configHash ?? null, lineage.taskId ?? null, lineage.traceId ?? null,
      lineage.producedAt, lineage.producedByTool ?? null,
    );
  } catch {
    // DB may not be available in all paths; lineage sidecar is the durable record.
  }
}
