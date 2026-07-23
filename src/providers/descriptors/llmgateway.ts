import type { ProviderDescriptor } from '../types.js';
export const llmgateway: ProviderDescriptor = {
  id: 'llmgateway', name: 'LLM Gateway', apiBase: 'https://api.llmgateway.io/v1',
  authScheme: 'bearer', envVar: 'LLMGATEWAY_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
