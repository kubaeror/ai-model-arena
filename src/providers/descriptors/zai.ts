import type { ProviderDescriptor } from '../types.js';
export const zai: ProviderDescriptor = {
  id: 'zai', name: 'Z.AI', apiBase: 'https://api.z.ai/api/coding/paas/v4',
  authScheme: 'bearer', envVar: 'ZAI_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
