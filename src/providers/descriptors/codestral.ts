import type { ProviderDescriptor } from '../types.js';
export const codestral: ProviderDescriptor = {
  id: 'codestral', name: 'Codestral', apiBase: 'https://api.mistral.ai/v1',
  authScheme: 'bearer', envVar: 'MISTRAL_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
