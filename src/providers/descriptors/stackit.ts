import type { ProviderDescriptor } from '../types.js';
export const stackit: ProviderDescriptor = {
  id: 'stackit', name: 'STACKIT', apiBase: 'https://api.stackit.cloud/ai/v1',
  authScheme: 'bearer', envVar: 'STACKIT_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
