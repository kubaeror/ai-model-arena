import type { ProviderDescriptor } from '../types.js';
export const meta: ProviderDescriptor = {
  id: 'meta', name: 'Meta AI', apiBase: 'https://api.meta.ai/v1',
  authScheme: 'bearer', envVar: 'META_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
