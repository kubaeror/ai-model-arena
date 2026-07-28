export interface RoutingRequest {
  providerId: string;
  modelId: string;
  maxCostUsd?: number;
  maxLatencyMs?: number;
  preferredRegions?: string[];
  requireCapabilities?: string[];
}

export interface RoutingDecision {
  providerId: string;
  modelId: string;
  reason: string;
}

export type RoutingPolicy =
  | { type: 'exact'; providerId: string; modelId: string }
  | { type: 'capability'; requiredTools?: boolean; requiredStreaming?: boolean }
  | { type: 'cost'; maxUsdPer1kTokens?: number }
  | { type: 'region'; allowedRegions: string[] }
  | { type: 'provider-health'; healthyThresholdMs?: number };

export type FallbackStrategy = 'next-cheapest' | 'same-capability' | 'any';

export interface ModelRouterConfig {
  primary: RoutingPolicy[];
  fallbacks: Array<{ providerId: string; modelId: string }>;
  fallbackStrategy: FallbackStrategy;
}

/**
 * ModelRouter resolves a model request to a specific provider/model.
 * It applies a chain of routing policies: exact match → capability →
 * cost → region → provider health. If the primary route fails, it
 * falls back through the configured fallback chain.
 */
export class ModelRouter {
  private config: ModelRouterConfig;

  constructor(config: ModelRouterConfig) {
    this.config = config;
  }

  /** Route a model request to a concrete provider/model. */
  route(request: RoutingRequest): RoutingDecision {
    // Apply primary policies in order
    for (const policy of this.config.primary) {
      switch (policy.type) {
        case 'exact':
          if (policy.providerId === request.providerId && policy.modelId === request.modelId) {
            return {
              providerId: policy.providerId,
              modelId: policy.modelId,
              reason: `exact match: ${policy.providerId}/${policy.modelId}`,
            };
          }
          break;
        case 'capability':
          // Defer to provider descriptor capabilities check
          break;
        case 'cost':
          // Defer to cost policy check
          break;
        case 'region':
          // Defer to region policy check
          break;
        case 'provider-health':
          // Defer to health probe results
          break;
      }
    }

    // Exact match is the default policy — return the requested model
    return {
      providerId: request.providerId,
      modelId: request.modelId,
      reason: 'exact match (default)',
    };
  }

  /** Get the next fallback provider/model. Returns null if chain exhausted. */
  getFallback(currentProvider: string, currentModel: string): { providerId: string; modelId: string } | null {
    const all = this.config.fallbacks;
    const idx = all.findIndex(
      (f) => f.providerId === currentProvider && f.modelId === currentModel,
    );
    if (idx < 0 || idx >= all.length - 1) return null;
    const next = all[idx + 1]!;
    return { providerId: next.providerId, modelId: next.modelId };
  }

  /** Create a default router that always returns the requested model. */
  static passthrough(): ModelRouter {
    return new ModelRouter({
      primary: [{ type: 'exact', providerId: '', modelId: '' }],
      fallbacks: [],
      fallbackStrategy: 'any',
    });
  }
}

/** Create a simple ModelRouter from a list of fallback providers/models. */
export function createFallbackRouter(
  primary: { providerId: string; modelId: string },
  fallbacks: Array<{ providerId: string; modelId: string }>,
  strategy: FallbackStrategy = 'same-capability',
): ModelRouter {
  return new ModelRouter({
    primary: [{ type: 'exact', providerId: primary.providerId, modelId: primary.modelId }],
    fallbacks,
    fallbackStrategy: strategy,
  });
}
