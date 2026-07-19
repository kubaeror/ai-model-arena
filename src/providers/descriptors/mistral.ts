import type { ProviderDescriptor } from '../types.js';
export const mistral: ProviderDescriptor = {
  id: 'mistral', name: 'Mistral La Plateforme', apiBase: 'https://api.mistral.ai/v1',
  authScheme: 'bearer', envVar: 'MISTRAL_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
