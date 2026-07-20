import type { ProviderRow, ModelRow } from './schema.js';
import { getDb } from './client.js';

/**
 * A model resolved from the SQLite catalog, ready to be used by a worker run.
 * Extracted from worker.ts so that orchestrator and evaluation layers do not
 * need to import the PM2 entry-point script (which has top-level side-effects).
 */
export interface ResolvedModel {
  canonicalId: string;
  providerId: string;
  apiModelId: string;
  adapterKind: ProviderRow['adapter'];
  envVar: string | null;
  contextLimit: number | null;
  maxTurns: number;
  temperature: number;
  maxTokens: number;
}

/** Default number of agent loop turns when the model config does not override. */
export const DEFAULT_MAX_TURNS = 20;

/** Default sampling temperature when the model config does not override. */
export const DEFAULT_TEMPERATURE = 0.2;

/**
 * Look up a model by friendly name or canonical ID and return all runtime
 * details needed to spawn a worker. Returns null if the model is not found in
 * the catalog.
 */
export function resolveModelForRun(friendlyName: string): ResolvedModel | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT m.*, mp.api_model_id, p.env_var, p.adapter as provider_adapter
    FROM models m
    JOIN model_providers mp ON mp.model_id = m.id
    JOIN providers p ON p.id = m.provider_id
    WHERE m.name = ? OR m.id = ?
    LIMIT 1
  `).get(friendlyName, friendlyName) as (ModelRow & { api_model_id: string; env_var: string | null; provider_adapter: string }) | undefined;
  if (!row) return null;
  return {
    canonicalId: row.id,
    providerId: row.provider_id,
    apiModelId: row.api_model_id,
    adapterKind: row.provider_adapter as ProviderRow['adapter'],
    envVar: row.env_var,
    contextLimit: row.context_limit,
    maxTurns: DEFAULT_MAX_TURNS,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: row.output_limit ?? 4096,
  };
}
