import type { ProviderDescriptor } from '../types.js';
export const cohere: ProviderDescriptor = {
  id: 'cohere', name: 'Cohere', apiBase: 'https://api.cohere.ai/v1',
  authScheme: 'bearer', envVar: 'COHERE_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
