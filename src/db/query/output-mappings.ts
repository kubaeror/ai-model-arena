import { eq } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { output_mappings } from '../schema.js';
import type { DbOutputMapping } from '../schema.js';

// ── Output Mappings ───────────────────────────────────────────────────────

export async function listOutputMappings(): Promise<DbOutputMapping[]> {
  const db = getDrizzleDb();
  return db.select().from(output_mappings).orderBy(output_mappings.scope, output_mappings.scope_id) as any;
}

export async function getOutputMappingById(id: string): Promise<DbOutputMapping | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(output_mappings).where(eq(output_mappings.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function insertOutputMapping(data: {
  id: string; scope: string; scopeId: string; parentFolder: string;
  perModelPattern: string; createdAt: string; updatedAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(output_mappings).values({
    id: data.id, scope: data.scope, scope_id: data.scopeId,
    parent_folder: data.parentFolder, per_model_pattern: data.perModelPattern,
    created_at: data.createdAt, updated_at: data.updatedAt,
  });
}

export async function updateOutputMapping(id: string, data: {
  scope?: string; scopeId?: string; parentFolder?: string;
  perModelPattern?: string; updatedAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  const set: Record<string, any> = { updated_at: data.updatedAt };
  if (data.scope !== undefined) set.scope = data.scope;
  if (data.scopeId !== undefined) set.scope_id = data.scopeId;
  if (data.parentFolder !== undefined) set.parent_folder = data.parentFolder;
  if (data.perModelPattern !== undefined) set.per_model_pattern = data.perModelPattern;
  await db.update(output_mappings).set(set).where(eq(output_mappings.id, id));
}

export async function deleteOutputMapping(id: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(output_mappings).where(eq(output_mappings.id, id));
}
