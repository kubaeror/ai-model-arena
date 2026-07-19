import type { ProviderDescriptor } from '../types.js';
export const openai: ProviderDescriptor = {
  id: 'openai', name: 'OpenAI', apiBase: 'https://api.openai.com/v1',
  authScheme: 'bearer', envVar: 'OPENAI_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
