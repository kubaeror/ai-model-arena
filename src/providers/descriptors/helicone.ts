import type { ProviderDescriptor } from '../types.js';
export const helicone: ProviderDescriptor = {
  id: 'helicone', name: 'Helicone', apiBase: 'https://ai-gateway.helicone.ai',
  authScheme: 'bearer', envVar: 'HELICONE_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
