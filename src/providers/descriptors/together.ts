import type { ProviderDescriptor } from '../types.js';
export const together: ProviderDescriptor = {
  id: 'together', name: 'Together AI', apiBase: 'https://api.together.xyz/v1',
  authScheme: 'bearer', envVar: 'TOGETHER_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
