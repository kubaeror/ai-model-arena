import type { ProviderDescriptor } from '../types.js';
export const baseten: ProviderDescriptor = {
  id: 'baseten', name: 'Baseten', apiBase: 'https://api.baseten.co/v1',
  authScheme: 'bearer', envVar: 'BASETEN_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
