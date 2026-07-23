import type { ProviderDescriptor } from '../types.js';
export const deepseek: ProviderDescriptor = {
  id: 'deepseek', name: 'DeepSeek', apiBase: 'https://api.deepseek.com/v1',
  authScheme: 'bearer', envVar: 'DEEPSEEK_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
