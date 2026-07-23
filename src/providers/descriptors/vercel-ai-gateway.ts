import type { ProviderDescriptor } from '../types.js';
export const vercelAIGateway: ProviderDescriptor = {
  id: 'vercel-ai-gateway', name: 'Vercel AI Gateway', apiBase: 'https://ai-gateway.vercel.sh/v1',
  authScheme: 'bearer', envVar: 'VERCEL_AI_GATEWAY_KEY', adapter: 'openai-compat', isBuiltin: true,
};
