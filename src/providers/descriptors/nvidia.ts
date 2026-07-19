import type { ProviderDescriptor } from '../types.js';
export const nvidia: ProviderDescriptor = {
  id: 'nvidia', name: 'NVIDIA NIM', apiBase: 'https://integrate.api.nvidia.com/v1',
  authScheme: 'bearer', envVar: 'NVIDIA_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
