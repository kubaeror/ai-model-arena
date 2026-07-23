import type { ProviderDescriptor } from '../types.js';
export const kilo: ProviderDescriptor = {
  id: 'kilo', name: 'Kilo', apiBase: 'https://api.kilo.ai/api/gateway',
  authScheme: 'none', adapter: 'openai-compat', isBuiltin: true,
};
