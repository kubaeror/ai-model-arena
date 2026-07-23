import type { ProviderDescriptor } from '../types.js';
export const gmiCloud: ProviderDescriptor = {
  id: 'gmi-cloud', name: 'GMI Cloud', apiBase: 'https://api.gmicloud.ai/v1',
  authScheme: 'bearer', envVar: 'GMI_CLOUD_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
