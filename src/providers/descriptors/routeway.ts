import type { ProviderDescriptor } from '../types.js';
export const routeway: ProviderDescriptor = {
  id: 'routeway', name: 'Routeway', apiBase: 'https://api.routeway.ai/v1',
  authScheme: 'bearer', envVar: 'ROUTEWAY_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
