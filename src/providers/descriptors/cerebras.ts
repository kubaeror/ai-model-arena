import type { ProviderDescriptor } from '../types.js';
export const cerebras: ProviderDescriptor = {
  id: 'cerebras', name: 'Cerebras', apiBase: 'https://api.cerebras.ai/v1',
  authScheme: 'bearer', envVar: 'CEREBRAS_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
