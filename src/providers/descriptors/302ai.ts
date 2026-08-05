import type { ProviderDescriptor } from '../types.js';
export const ai302: ProviderDescriptor = {
  id: '302ai', name: '302.AI', apiBase: 'https://api.302.ai/v1',
  authScheme: 'bearer', envVar: 'AI302_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
