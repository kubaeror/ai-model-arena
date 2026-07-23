import type { ProviderDescriptor } from '../types.js';
export const moonshot: ProviderDescriptor = {
  id: 'moonshot', name: 'Moonshot AI', apiBase: 'https://api.moonshot.ai/v1',
  authScheme: 'bearer', envVar: 'MOONSHOT_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
