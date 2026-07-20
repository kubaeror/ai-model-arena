import type { ProviderDescriptor } from '../types.js';
export const xai: ProviderDescriptor = {
  id: 'xai', name: 'xAI', apiBase: 'https://api.x.ai/v1',
  authScheme: 'bearer', envVar: 'XAI_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
