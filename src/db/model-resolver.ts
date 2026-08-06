import type { ProviderRow } from './schema.js';
import { getModelByNameOrId } from './query.js';

/**
 * A model resolved from the SQLite catalog, ready to be used by a runner.
 * Extracted from runner.ts so that orchestrator and evaluation layers do not
 * need to import the runner entry-point script (which has top-level side-effects).
 */
interface ResolvedModel {
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
const DEFAULT_MAX_TURNS = 20;

/** Default sampling temperature when the model config does not override. */
const DEFAULT_TEMPERATURE = 0.2;

/**
 * Look up a model by friendly name or canonical ID and return all runtime
 * details needed to spawn a worker. Returns null if the model is not found in
 * the catalog.
 */
export async function resolveModelForRun(friendlyName: string): Promise<ResolvedModel | null> {
  const row = await getModelByNameOrId(friendlyName);
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
