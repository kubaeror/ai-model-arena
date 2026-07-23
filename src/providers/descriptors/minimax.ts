import type { ProviderDescriptor } from '../types.js';
export const minimax: ProviderDescriptor = {
  id: 'minimax', name: 'MiniMax', apiBase: 'https://api.minimax.io/v1',
  authScheme: 'bearer', envVar: 'MINIMAX_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
