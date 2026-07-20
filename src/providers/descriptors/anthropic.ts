import type { ProviderDescriptor } from '../types.js';
export const anthropic: ProviderDescriptor = {
  id: 'anthropic', name: 'Anthropic', apiBase: 'https://api.anthropic.com',
  authScheme: 'x-api-key', envVar: 'ANTHROPIC_API_KEY', adapter: 'anthropic', isBuiltin: true,
};
