/**
 * Runtime capability detection for provider endpoints.
 *
 * Sends a lightweight probe request to verify the endpoint is reachable and
 * to discover actual capabilities rather than relying solely on static config.
 */

import type { ProviderHealthCheck } from './types.js';

/**
 * Probe an OpenAI-compatible endpoint to verify reachability and detect
 * key capabilities like tool/function-calling support.
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

    const data = await resp.json() as { data?: Array<{ id: string }> };
    const models = data?.data ?? [];
    const modelIds = models.map(m => m.id);

    // Attempt to detect capabilities by model naming conventions
    const detectedCapabilities = {
      streaming: true, // most OpenAI-compat endpoints support streaming
      tools: modelIds.some(id => /gpt|claude|gemini|mistral|command/i.test(id)),
      structuredOutput: false, // requires a request probe with response_format
      reasoning: modelIds.some(id => /o1|o3|deepseek-r1|claude-3.[57]/i.test(id)),
      promptCaching: modelIds.some(id => /claude|gemini-1\.5|gemini-2/i.test(id)),
      vision: modelIds.some(id => /vision|gpt-4o|claude-3|gemini/i.test(id)),
    };

    return {
      reachable: true,
      latencyMs,
      detectedCapabilities,
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
