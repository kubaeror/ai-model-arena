import type { ProviderDescriptor } from '../types.js';
export const fireworks: ProviderDescriptor = {
  id: 'fireworks', name: 'Fireworks AI', apiBase: 'https://api.fireworks.ai/inference/v1',
  authScheme: 'bearer', envVar: 'FIREWORKS_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
