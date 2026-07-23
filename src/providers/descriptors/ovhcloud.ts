import type { ProviderDescriptor } from '../types.js';
export const ovhcloud: ProviderDescriptor = {
  id: 'ovhcloud', name: 'OVHcloud AI Endpoints', apiBase: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
  authScheme: 'bearer', envVar: 'OVH_AI_ENDPOINTS_ACCESS_TOKEN', adapter: 'openai-compat', isBuiltin: true,
};
