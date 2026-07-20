import type { ProviderDescriptor } from '../types.js';
export const groq: ProviderDescriptor = {
  id: 'groq', name: 'Groq', apiBase: 'https://api.groq.com/openai/v1',
  authScheme: 'bearer', envVar: 'GROQ_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
