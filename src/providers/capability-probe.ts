/**
 * Runtime reachability probe for provider endpoints.
 *
 * Sends a lightweight probe request to verify the endpoint is reachable and
 * responds to /models. Capability detection by model-name regex was removed —
 * it was consumed nowhere.
 */

import type { ProviderHealthCheck } from './types.js';

/**
 * Probe an OpenAI-compatible endpoint to verify reachability.
 */
export async function probeOpenAICompatEndpoint(
  apiBase: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<ProviderHealthCheck> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${apiBase}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    const latencyMs = Date.now() - start;

    if (!resp.ok) {
      return {
        reachable: false,
        latencyMs,
        error: `HTTP ${resp.status}: ${await resp.text().catch(() => 'unknown')}`,
      };
    }

    await resp.json();
    return {
      reachable: true,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      reachable: false,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
