import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { insertFile } from '../db/query.js';

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
    await insertFile({
      id: lineage.id, runId: lineage.runId, path: lineage.path,
      promptId: lineage.promptId ?? null, promptVersion: lineage.promptVersion ?? null,
      model: lineage.model, configHash: lineage.configHash ?? null,
      taskId: lineage.taskId ?? null, traceId: lineage.traceId ?? null,
      producedAt: lineage.producedAt, producedByTool: lineage.producedByTool ?? null,
    });
  } catch {
    // DB may not be available in all paths; lineage sidecar is the durable record.
  }
}
