import type { ProviderDescriptor } from '../types.js';
export const frogbot: ProviderDescriptor = {
  id: 'frogbot', name: 'FrogBot', apiBase: 'https://api.frogbot.ai/v1',
  authScheme: 'bearer', envVar: 'FROGBOT_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
