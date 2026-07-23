import type { ProviderDescriptor } from '../types.js';
export const nebius: ProviderDescriptor = {
  id: 'nebius', name: 'Nebius Token Factory', apiBase: 'https://api.nebius.ai/v1',
  authScheme: 'bearer', envVar: 'NEBIUS_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
