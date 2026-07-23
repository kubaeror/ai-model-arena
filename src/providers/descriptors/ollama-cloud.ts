import type { ProviderDescriptor } from '../types.js';
export const ollamaCloud: ProviderDescriptor = {
  id: 'ollama-cloud', name: 'Ollama Cloud', apiBase: 'https://ollama.com/v1',
  authScheme: 'bearer', envVar: 'OLLAMA_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
