import type { ProviderDescriptor } from '../types.js';
export const llamacpp: ProviderDescriptor = {
  id: 'llamacpp', name: 'llama.cpp (local)', apiBase: 'http://127.0.0.1:8080/v1',
  authScheme: 'none', adapter: 'openai-compat', isBuiltin: true,
};
