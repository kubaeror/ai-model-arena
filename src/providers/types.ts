type AdapterKind = 'openai-compat' | 'anthropic' | 'google' | 'bedrock';
type AuthScheme = 'bearer' | 'x-api-key' | 'google' | 'bedrock' | 'none';

export interface ProviderDescriptor {
  id: string;
  name: string;
  apiBase?: string;
  authScheme: AuthScheme;
  envVar?: string;
  headerName?: string;
  adapter: AdapterKind;
  isBuiltin: boolean;
}

/** Result of a runtime reachability probe against a provider endpoint. */
export interface ProviderHealthCheck {
  reachable: boolean;
  latencyMs: number | null;
  error?: string;
}
