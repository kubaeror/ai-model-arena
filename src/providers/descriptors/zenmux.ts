import type { ProviderDescriptor } from '../types.js';
export const zenmux: ProviderDescriptor = {
  id: 'zenmux', name: 'ZenMux', apiBase: 'https://api.zenmux.ai/v1',
  authScheme: 'bearer', envVar: 'ZENMUX_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
