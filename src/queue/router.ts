/**
 * Maps provider IDs to their Redis stream adapter-family groups.
 * Tasks are routed to streams by adapter family, not individual provider,
 * so a single runner Deployment can handle 10+ OpenAI-compatible providers.
 *
 * The map is DERIVED from the provider descriptors (single source of truth)
 * so new builtin providers automatically share their adapter family's stream.
 * Custom providers (loaded from DB after module init) fall back to their own
 * per-provider stream, matching the previous behavior.
 */
import { BUILTIN_PROVIDERS } from '../providers/index.js';

/** Explicit routing overrides on top of descriptor adapters. */
const FAMILY_OVERRIDES: Record<string, string> = {
  // Bedrock uses AWS IAM auth (no API key) — keep it on its own stream.
  bedrock: 'bedrock',
  // ollama is self-hosted but speaks the OpenAI-compatible protocol.
  ollama: 'openai-compat',
};

const providerFamilies = new Map<string, string>();
for (const d of BUILTIN_PROVIDERS) {
  providerFamilies.set(d.id, FAMILY_OVERRIDES[d.id] ?? d.adapter);
}

export function familyFor(provider: string): string {
  return providerFamilies.get(provider) ?? provider;
}

export function streamKey(prefix: string, provider: string): string {
  return `${prefix}:${familyFor(provider)}`;
}

export function dlqStreamKey(prefix: string, provider: string): string {
  return `${prefix}:${familyFor(provider)}:dlq`;
}

/** All builtin provider IDs, in declaration order — used to enumerate per-provider queues. */
export const knownProviders: string[] = [...providerFamilies.keys()];
