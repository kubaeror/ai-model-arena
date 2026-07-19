import type { ProviderDescriptor } from '../types.js';
export const sambanova: ProviderDescriptor = {
  id: 'sambanova', name: 'SambaNova', apiBase: 'https://api.sambanova.ai/v1',
  authScheme: 'bearer', envVar: 'SAMBANOVA_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
