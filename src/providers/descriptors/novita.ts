import type { ProviderDescriptor } from '../types.js';
export const novita: ProviderDescriptor = {
  id: 'novita', name: 'Novita AI', apiBase: 'https://api.novita.ai/openai/v1',
  authScheme: 'bearer', envVar: 'NOVITA_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
