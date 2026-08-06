import { eq, desc, max, asc, inArray } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { prompts, prompt_versions } from '../schema.js';
import type { DbPrompt, DbPromptVersion } from '../schema.js';

// ── Prompts ───────────────────────────────────────────────────────────────

export async function getPromptById(id: string): Promise<DbPrompt | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(prompts).where(eq(prompts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listPromptVersions(promptId: string): Promise<DbPromptVersion[]> {
  const db = getDrizzleDb();
  return db.select().from(prompt_versions)
    .where(eq(prompt_versions.prompt_id, promptId))
    .orderBy(desc(prompt_versions.version));
}

export async function getLatestPromptVersion(promptId: string): Promise<number> {
  const db = getDrizzleDb();
  const rows = await db.select({ maxVer: max(prompt_versions.version) })
    .from(prompt_versions)
    .where(eq(prompt_versions.prompt_id, promptId));
  return rows[0]?.maxVer ?? 1;
}

// ── Dashboard: prompts helpers ────────────────────────────────────────────

export async function listPromptsWithLatestVersion(): Promise<Array<{
  id: string; name: string; description: string | null;
  created_at: string; updated_at: string;
  latest_version: number | null; latest_tag: string | null;
}>> {
  const db = getDrizzleDb();
  const promptRows = await db.select().from(prompts).orderBy(asc(prompts.name));
  if (promptRows.length === 0) return [];
  const ids = promptRows.map((p: { id: string }) => p.id);
  const versions = await db.select().from(prompt_versions)
    .where(inArray(prompt_versions.prompt_id, ids))
    .orderBy(desc(prompt_versions.version));
  // First row per prompt is the latest version (descending order).
  const latest = new Map<string, (typeof versions)[number]>();
  for (const v of versions) {
    if (!latest.has(v.prompt_id)) latest.set(v.prompt_id, v);
  }
  return promptRows.map((p: { id: string; name: string; description: string | null; created_at: string; updated_at: string }) => {
    const lv = latest.get(p.id);
    return {
      id: p.id, name: p.name, description: p.description,
      created_at: p.created_at, updated_at: p.updated_at,
      latest_version: lv?.version ?? null,
      latest_tag: lv?.tag ?? null,
    };
  });
}

export async function insertPrompt(data: {
  id: string; name: string; description: string | null; createdAt: string; updatedAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(prompts).values({
    id: data.id, name: data.name, description: data.description,
    created_at: data.createdAt, updated_at: data.updatedAt,
  });
}

export async function updatePromptMetadata(id: string, data: {
  name?: string; description?: string | null; updatedAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  const set: Record<string, string | null | undefined> = { updated_at: data.updatedAt };
  if (data.name !== undefined) set.name = data.name;
  if (data.description !== undefined) set.description = data.description;
  await db.update(prompts).set(set).where(eq(prompts.id, id));
}

export async function deletePromptById(id: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(prompt_versions).where(eq(prompt_versions.prompt_id, id));
  await db.delete(prompts).where(eq(prompts.id, id));
}

export async function insertPromptVersion(data: {
  id: string; promptId: string; version: number; systemPrompt: string; task: string;
  config: string | null; tag: string | null; createdAt: string; createdBy: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(prompt_versions).values({
    id: data.id, prompt_id: data.promptId, version: data.version,
    system_prompt: data.systemPrompt, task: data.task,
    config: data.config, tag: data.tag,
    created_at: data.createdAt, created_by: data.createdBy,
  });
}
