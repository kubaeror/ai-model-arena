import type { ProviderDescriptor } from '../types.js';
export const lmstudio: ProviderDescriptor = {
  id: 'lmstudio', name: 'LM Studio (local)', apiBase: 'http://127.0.0.1:1234/v1',
  authScheme: 'none', adapter: 'openai-compat', isBuiltin: true,
};
