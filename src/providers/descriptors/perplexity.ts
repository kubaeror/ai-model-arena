import type { ProviderDescriptor } from '../types.js';
export const perplexity: ProviderDescriptor = {
  id: 'perplexity', name: 'Perplexity', apiBase: 'https://api.perplexity.ai',
  authScheme: 'bearer', envVar: 'PERPLEXITY_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
