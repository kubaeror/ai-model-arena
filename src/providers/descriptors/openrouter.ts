import type { ProviderDescriptor } from '../types.js';
export const openrouter: ProviderDescriptor = {
  id: 'openrouter', name: 'OpenRouter', apiBase: 'https://openrouter.ai/api/v1',
  authScheme: 'bearer', envVar: 'OPENROUTER_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
