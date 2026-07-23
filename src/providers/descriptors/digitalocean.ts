import type { ProviderDescriptor } from '../types.js';
export const digitalocean: ProviderDescriptor = {
  id: 'digitalocean', name: 'DigitalOcean Inference', apiBase: 'https://api.digitalocean.com/v1/genai',
  authScheme: 'bearer', envVar: 'DIGITALOCEAN_ACCESS_TOKEN', adapter: 'openai-compat', isBuiltin: true,
};
