import type { ProviderDescriptor } from '../types.js';
export const ollama: ProviderDescriptor = {
  id: 'ollama', name: 'Ollama (local)', apiBase: 'http://localhost:11434/v1',
  authScheme: 'none', adapter: 'openai-compat', isBuiltin: true,
};
