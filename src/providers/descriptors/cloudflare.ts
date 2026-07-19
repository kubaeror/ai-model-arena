import type { ProviderDescriptor } from '../types.js';
export const cloudflare: ProviderDescriptor = {
  id: 'cloudflare', name: 'Cloudflare Workers AI', apiBase: 'https://api.cloudflare.com/client/v4/accounts',
  authScheme: 'bearer', envVar: 'CLOUDFLARE_API_TOKEN', adapter: 'openai-compat', isBuiltin: true,
};
