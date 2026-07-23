/**
 * Maps provider IDs to their Redis stream adapter-family groups.
 * Tasks are routed to streams by adapter family, not individual provider,
 * so a single runner Deployment can handle 10+ OpenAI-compatible providers.
 *
 * Bedrock uses AWS IAM auth (no API key); ollama is self-hosted.
 * Both are excluded from shared-routed streams for now.
 */
const PROVIDER_ADAPTER_FAMILIES: Record<string, string> = {
  openai:     'openai-compat',
  groq:       'openai-compat',
  cerebras:   'openai-compat',
  nvidia:     'openai-compat',
  mistral:    'openai-compat',
  sambanova:  'openai-compat',
  scaleway:   'openai-compat',
  cloudflare: 'openai-compat',
  'github-copilot': 'openai-compat',
  xai:        'openai-compat',
  openrouter: 'openai-compat',
  ollama:     'openai-compat',

  anthropic:  'anthropic',
  google:     'google',
};

export function streamKey(prefix: string, provider: string): string {
  const family = PROVIDER_ADAPTER_FAMILIES[provider] ?? provider;
  return `${prefix}:${family}`;
}

export function dlqStreamKey(prefix: string, provider: string): string {
  const family = PROVIDER_ADAPTER_FAMILIES[provider] ?? provider;
  return `${prefix}:${family}:dlq`;
}

export { PROVIDER_ADAPTER_FAMILIES };
