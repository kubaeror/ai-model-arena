export type AdapterKind = 'openai-compat' | 'anthropic' | 'google' | 'bedrock';
export type AuthScheme = 'bearer' | 'x-api-key' | 'google' | 'bedrock' | 'none';

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  promptCaching: boolean;
  vision: boolean;
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  apiBase?: string;
  authScheme: AuthScheme;
  envVar?: string;
  headerName?: string;
  adapter: AdapterKind;
  isBuiltin: boolean;
  capabilities?: ProviderCapabilities;
}

/** Result of a runtime capability probe against a provider endpoint. */
export interface ProviderHealthCheck {
  reachable: boolean;
  latencyMs: number | null;
  detectedCapabilities?: Partial<ProviderCapabilities>;
  error?: string;
}
