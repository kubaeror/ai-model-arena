import type { ProviderRow } from './schema.js';
import { getModelByNameOrId } from './query.js';

/**
 * A model resolved from the SQLite catalog, ready to be used by a runner.
 * Extracted from runner.ts so that orchestrator and evaluation layers do not
 * need to import the runner entry-point script (which has top-level side-effects).
 */
export interface ResolvedModel {
  canonicalId: string;
  providerId: string;
  apiModelId: string;
  adapterKind: ProviderRow['adapter'];
  envVar: string | null;
  contextLimit: number | null;
  maxTurns: number;
  /**
   * Sampling temperature when the catalog marks the model temperature-capable;
   * null when it does not (callers must omit the parameter).
   */
  temperature: number | null;
  /** Catalog output limit; null when unknown (callers must omit max tokens). */
  maxTokens: number | null;
  /**
   * Catalog marks the model reasoning-only (reasoning-capable but not
   * temperature-capable). OpenAI-compatible reasoning models reject
   * `temperature` and `max_tokens` (they need `max_completion_tokens`), so
   * callers omit both parameters rather than send the unsupported forms.
   */
  reasoningOnly: boolean;
}

/** Default number of agent loop turns when the model config does not override. */
const DEFAULT_MAX_TURNS = 20;

/** Default sampling temperature when the model config does not override. */
const DEFAULT_TEMPERATURE = 0.2;

/**
 * Look up a model by friendly name or canonical ID and return all runtime
 * details needed to spawn a worker. Returns null if the model is not found in
 * the catalog.
 *
 * `providerId` narrows the lookup (including API-model-id matches) when the
 * caller already knows the provider — fallback hops pass their chain provider
 * so a shared api_model_id cannot resolve to another provider's row.
 */
export async function resolveModelForRun(friendlyName: string, providerId?: string): Promise<ResolvedModel | null> {
  const row = await getModelByNameOrId(friendlyName, providerId);
  if (!row) return null;
  const supportsTemperature = row.temperature === 1;
  return {
    canonicalId: row.id,
    providerId: row.provider_id,
    apiModelId: row.api_model_id,
    adapterKind: row.provider_adapter as ProviderRow['adapter'],
    envVar: row.env_var,
    contextLimit: row.context_limit,
    maxTurns: DEFAULT_MAX_TURNS,
    temperature: supportsTemperature ? DEFAULT_TEMPERATURE : null,
    maxTokens: row.output_limit,
    reasoningOnly: row.reasoning === 1 && !supportsTemperature,
  };
}
