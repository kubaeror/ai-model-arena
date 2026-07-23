import type { ProviderDescriptor } from '../types.js';
export const llm7: ProviderDescriptor = {
  id: 'llm7', name: 'LLM7', apiBase: 'https://api.llm7.io/v1',
  authScheme: 'bearer', envVar: 'LLM7_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
