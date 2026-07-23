import type { ProviderDescriptor } from '../types.js';
export const deepinfra: ProviderDescriptor = {
  id: 'deepinfra', name: 'Deep Infra', apiBase: 'https://api.deepinfra.com/v1/openai',
  authScheme: 'bearer', envVar: 'DEEPINFRA_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
