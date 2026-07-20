export type AdapterKind = 'openai-compat' | 'anthropic' | 'google' | 'bedrock';
export type AuthScheme = 'bearer' | 'x-api-key' | 'google' | 'bedrock' | 'none';

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
