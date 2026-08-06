import { getDrizzleDb } from '../index.js';
import { files } from '../schema.js';

// ── Files ─────────────────────────────────────────────────────────────────

export async function insertFile(data: {
  id: string; runId: string; path: string; promptId?: string | null;
  promptVersion?: number | null; model: string; configHash?: string | null;
  taskId?: string | null; traceId?: string | null; producedAt: string;
  producedByTool?: string | null;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(files).values({
    id: data.id, run_id: data.runId, path: data.path,
    prompt_id: data.promptId ?? null, prompt_version: data.promptVersion ?? null,
    model: data.model, config_hash: data.configHash ?? null,
    task_id: data.taskId ?? null, trace_id: data.traceId ?? null,
    produced_at: data.producedAt, produced_by_tool: data.producedByTool ?? null,
  });
}
