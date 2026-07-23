import type { ProviderDescriptor } from '../types.js';
export const atomicChat: ProviderDescriptor = {
  id: 'atomic-chat', name: 'Atomic Chat (local)', apiBase: 'http://127.0.0.1:1337/v1',
  authScheme: 'none', adapter: 'openai-compat', isBuiltin: true,
};
