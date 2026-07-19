import type { ProviderDescriptor } from '../types.js';
export const scaleway: ProviderDescriptor = {
  id: 'scaleway', name: 'Scaleway', apiBase: 'https://api.scaleway.ai/ai-apis/v1',
  authScheme: 'bearer', envVar: 'SCALEWAY_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
