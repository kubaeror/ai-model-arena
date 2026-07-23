import type { ProviderDescriptor } from '../types.js';
export const huggingface: ProviderDescriptor = {
  id: 'huggingface', name: 'Hugging Face', apiBase: 'https://api-inference.huggingface.co/v1',
  authScheme: 'bearer', envVar: 'HUGGINGFACE_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
