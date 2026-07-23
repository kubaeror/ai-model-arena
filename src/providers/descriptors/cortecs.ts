import type { ProviderDescriptor } from '../types.js';
export const cortecs: ProviderDescriptor = {
  id: 'cortecs', name: 'Cortecs', apiBase: 'https://api.cortecs.ai/v1',
  authScheme: 'bearer', envVar: 'CORTECS_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
