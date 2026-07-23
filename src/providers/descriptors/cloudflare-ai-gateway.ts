import type { ProviderDescriptor } from '../types.js';
export const cloudflareAIGateway: ProviderDescriptor = {
  id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway', apiBase: 'https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}',
  authScheme: 'bearer', envVar: 'CLOUDFLARE_API_TOKEN', adapter: 'openai-compat', isBuiltin: true,
};
