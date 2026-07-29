import { getDrizzleDb } from '../db/index.js';
import type { Logger } from '../types.js';

export type ModelLifecycle = 'active' | 'deprecated' | 'sunset' | 'end_of_life';

export interface DeprecatedModel {
  id: string;
  name: string;
  providerId: string;
  status: ModelLifecycle;
  deprecationDate?: string;
  sunsetDate?: string;
  replacementModelId?: string;
  notes?: string;
}

/**
 * Check if a model is deprecated and should not be used for new runs.
 * Returns the lifecycle status and replacement suggestion if available.
 */
export function getModelLifecycle(modelName: string): { lifecycle: ModelLifecycle; replacement?: string } {
  const db = getDrizzleDb() as any;
  const rows = db.all(
    `SELECT status, replacement_model_id FROM models WHERE id = ? OR name = ? LIMIT 1`,
    modelName, modelName,
  ) as Array<{ status: string; replacement_model_id: string | null }>;
  if (!rows.length) return { lifecycle: 'active' };

  const status = rows[0]!.status;
  if (status === 'end_of_life' || status === 'sunset') {
    return {
      lifecycle: status as ModelLifecycle,
      replacement: rows[0]!.replacement_model_id ?? undefined,
    };
  }
  if (status === 'deprecated') {
    return {
      lifecycle: 'deprecated',
      replacement: rows[0]!.replacement_model_id ?? undefined,
    };
  }
  return { lifecycle: 'active' };
}

/**
 * List all deprecated or sunset models for the dashboard.
 */
export function listDeprecatedModels(): DeprecatedModel[] {
  const db = getDrizzleDb() as any;
  const rows = db.all(
    `SELECT m.id, m.name, m.provider_id, m.status, m.deprecation_date, m.sunset_date, m.replacement_model_id
     FROM models m
     WHERE m.status IN ('deprecated', 'sunset', 'end_of_life')
     ORDER BY m.status, m.name`,
  );

  return rows.map((r: Record<string, unknown>) => ({
    id: String(r.id),
    name: String(r.name),
    providerId: String(r.provider_id),
    status: String(r.status) as ModelLifecycle,
    deprecationDate: r.deprecation_date as string | undefined,
    sunsetDate: r.sunset_date as string | undefined,
    replacementModelId: r.replacement_model_id as string | undefined,
  }));
}

/**
 * Warn if a model is approaching deprecation. Use before scheduling runs
 * to alert operators to plan model migrations.
 */
export function checkDeprecationWarnings(
  modelName: string,
  logger?: Logger,
): void {
  const lifecycle = getModelLifecycle(modelName);

  switch (lifecycle.lifecycle) {
    case 'deprecated':
      logger?.warn('Model is deprecated — plan migration', {
        model: modelName,
        replacement: lifecycle.replacement,
      });
      break;
    case 'sunset':
      logger?.error('Model is sunset — migrating runs to replacement', {
        model: modelName,
        replacement: lifecycle.replacement,
      });
      break;
    case 'end_of_life':
      logger?.error('Model is end-of-life — no new runs allowed', {
        model: modelName,
      });
      break;
  }
}
