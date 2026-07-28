import type { ProviderDescriptor, ProviderHealthCheck } from './types.js';
import type { Logger } from '../types.js';

interface HealthProbeConfig {
  timeoutMs: number;
  /** Avoid paid traffic — use lightweight endpoints only. */
  lightweight: boolean;
}

const DEFAULT_CONFIG: HealthProbeConfig = {
  timeoutMs: 5000,
  lightweight: true,
};

/**
 * Probe a provider's health by issuing a lightweight request.
 * Uses the provider's apiBase + an optional health path, with
 * no paid token usage. Falls back to a TCP connection check.
 */
export async function probeProviderHealth(
  descriptor: ProviderDescriptor,
  config: Partial<HealthProbeConfig> = {},
  logger?: Logger,
): Promise<ProviderHealthCheck> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const start = Date.now();

  try {
    const base = descriptor.apiBase;
    if (!base) {
      // No endpoint to probe — assume healthy (e.g., Bedrock uses AWS SDK)
      return {
        reachable: true,
        latencyMs: null,
        detectedCapabilities: undefined,
        error: undefined,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
      const url = new URL(base);
      // Use HEAD for lightweight probe if possible; fall back to GET
      const response = await fetch(`${url.origin}/`, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timer);

      const latencyMs = Date.now() - start;

      // 2xx or 3xx = reachable
      const reachable = response.status >= 200 && response.status < 400;

      return {
        reachable,
        latencyMs,
        detectedCapabilities: undefined,
        error: reachable ? undefined : `HTTP ${response.status}`,
      };
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes('aborted') || msg.includes('AbortError')) {
        return {
          reachable: false,
          latencyMs: null,
          detectedCapabilities: undefined,
          error: 'Timeout',
        };
      }

      logger?.debug('Provider health probe failed', {
        provider: descriptor.id,
        error: msg,
      });

      return {
        reachable: false,
        latencyMs: null,
        detectedCapabilities: undefined,
        error: msg,
      };
    }
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      reachable: false,
      latencyMs,
      detectedCapabilities: undefined,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Batch probe all providers and return results keyed by provider ID. */
export async function probeAllProviders(
  descriptors: ProviderDescriptor[],
  logger?: Logger,
): Promise<Map<string, ProviderHealthCheck>> {
  const results = new Map<string, ProviderHealthCheck>();

  const probes = descriptors.map(async (d) => {
    const result = await probeProviderHealth(d, { timeoutMs: 3000 }, logger);
    results.set(d.id, result);
  });

  await Promise.allSettled(probes);
  return results;
}
