import type { ProviderDescriptor } from '../types.js';
export const ionet: ProviderDescriptor = {
  id: 'ionet', name: 'IO.NET', apiBase: 'https://api.io.net/v1',
  authScheme: 'bearer', envVar: 'IONET_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
