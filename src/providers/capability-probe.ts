/**
 * Runtime reachability probe for provider endpoints.
 *
 * Sends a lightweight per-adapter-kind probe request to verify the endpoint is
 * reachable and responds. Capability detection by model-name regex was removed —
 * it was consumed nowhere.
 */

import type { ProviderDescriptor, ProviderHealthCheck } from './types.js';
import type { LookupAll } from './ip-ranges.js';
import { assertPublicUrl } from './url-validator.js';

interface ProbeOpts {
  apiKey?: string;
  timeoutMs?: number;
  /** Model id for probes that need one (anthropic count_tokens). */
  model?: string;
  /** DNS resolver seam for tests. */
  lookup?: LookupAll;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_BYTES = 4096;

/**
 * Placeholder model for the anthropic count_tokens probe when no concrete
 * model id is known (dashboard probing is per-provider, not per-model).
 * Override via ProbeOpts.model when the caller has a real model id.
 */
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4';

interface ProbeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * Probe a provider endpoint for reachability, dispatching the request shape
 * per adapter kind:
 * - openai-compat / others: GET {apiBase}/models
 * - anthropic: POST {apiBase}/v1/messages/count_tokens (1-token message)
 * - google: GET {apiBase}/v1beta/models (models.list; see probeGoogle note)
 * - bedrock: GET {gateway}/health when gateway mode, else reachable without
 *   a network call (native SigV4 mode cannot be probed without assuming an
 *   AWS identity).
 */
export async function probeProvider(
  descriptor: ProviderDescriptor,
  opts: ProbeOpts = {},
): Promise<ProviderHealthCheck> {
  if (descriptor.adapter === 'bedrock') {
    return probeBedrockEndpoint(descriptor, opts);
  }

  const apiBase = descriptor.apiBase;
  if (!apiBase) {
    return { reachable: false, latencyMs: null, error: 'Provider has no apiBase to probe' };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  switch (descriptor.adapter) {
    case 'anthropic':
      return probeFetch(anthropicProbeRequest(apiBase, opts), timeoutMs, opts.lookup);
    case 'google':
      return probeFetch(googleProbeRequest(apiBase, opts), timeoutMs, opts.lookup);
    case 'openai-compat':
    default:
      return probeOpenAICompatEndpoint(apiBase, opts.apiKey ?? '', timeoutMs, opts.lookup);
  }
}

/**
 * Probe an OpenAI-compatible endpoint to verify reachability.
 */
async function probeOpenAICompatEndpoint(
  apiBase: string,
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  lookup?: LookupAll,
): Promise<ProviderHealthCheck> {
  return probeFetch({
    method: 'GET',
    url: `${apiBase}/models`,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
    },
  }, timeoutMs, lookup);
}

/**
 * Anthropic probe: POST /v1/messages/count_tokens with a 1-token message.
 * Cheapest non-billing round trip that exercises auth + routing; mirrors the
 * adapter's anthropic-version/x-api-key header set.
 */
function anthropicProbeRequest(apiBase: string, opts: ProbeOpts): ProbeRequest {
  return {
    method: 'POST',
    url: `${apiBase}/v1/messages/count_tokens`,
    headers: {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      ...(opts.apiKey ? { 'x-api-key': opts.apiKey } : {}),
    },
    body: {
      model: opts.model ?? DEFAULT_ANTHROPIC_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    },
  };
}

/**
 * Google probe: GET /v1beta/models (models.list).
 *
 * Note: the brief's literal POST {apiBase}/models/{model}:generateContent with
 * empty contents would always 400 (contents must be non-empty) — a permanent
 * false negative. The probe is per-provider with no model id available, so the
 * models.list endpoint is used instead: same /v1beta prefix and x-goog-api-key
 * auth as the adapter, and returns 200 when the endpoint is reachable.
 */
function googleProbeRequest(apiBase: string, opts: ProbeOpts): ProbeRequest {
  return {
    method: 'GET',
    url: `${apiBase}/v1beta/models`,
    headers: {
      'x-goog-api-key': opts.apiKey ?? '',
      'Accept': 'application/json',
    },
  };
}

/**
 * Bedrock probe. Gateway mode (descriptor.apiBase or AWS_BEDROCK_GATEWAY_URL)
 * does GET {gateway}/health with a bearer key. Native SigV4 mode returns
 * reachable without a network call: probing AWS requires credentials, which
 * this module must not assume.
 */
async function probeBedrockEndpoint(
  descriptor: ProviderDescriptor,
  opts: ProbeOpts,
): Promise<ProviderHealthCheck> {
  const gateway = descriptor.apiBase ?? process.env.AWS_BEDROCK_GATEWAY_URL;
  if (!gateway) {
    return { reachable: true, latencyMs: null };
  }
  const gatewayKey = opts.apiKey ?? process.env.AWS_BEDROCK_GATEWAY_KEY ?? '';
  return probeFetch({
    method: 'GET',
    url: `${gateway}/health`,
    headers: {
      'Authorization': `Bearer ${gatewayKey}`,
      'Accept': 'application/json',
    },
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.lookup);
}

async function readCappedBody(resp: Response, maxBytes = MAX_ERROR_BODY_BYTES): Promise<string> {
  const body = resp.body;
  if (!body) {
    const text = await resp.text().catch(() => 'unknown');
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}…[truncated]` : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = maxBytes - total;
      chunks.push(value.byteLength > remaining ? value.subarray(0, remaining) : value);
      total += Math.min(value.byteLength, remaining);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return total >= maxBytes ? `${text}…[truncated]` : text;
}

async function probeFetch(req: ProbeRequest, timeoutMs: number, lookup?: LookupAll): Promise<ProviderHealthCheck> {
  const start = Date.now();
  const init: RequestInit = {
    method: req.method,
    headers: req.headers,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  };
  if (req.body !== undefined) {
    init.body = JSON.stringify(req.body);
  }

  try {
    await assertPublicUrl(req.url, lookup ? { lookup } : undefined);
    const resp = await fetch(req.url, init);
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      return {
        reachable: false,
        latencyMs,
        error: `HTTP ${resp.status}: ${await readCappedBody(resp)}`,
      };
    }
    // Reachability is judged on the status line only: some endpoints (e.g.
    // gateway /health) may return 204 with no body, so no JSON parse here.
    return { reachable: true, latencyMs };
  } catch (err) {
    return {
      reachable: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
