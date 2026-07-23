import type { ProviderDescriptor } from '../types.js';
export const venice: ProviderDescriptor = {
  id: 'venice', name: 'Venice AI', apiBase: 'https://api.venice.ai/api/v1',
  authScheme: 'bearer', envVar: 'VENICE_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
