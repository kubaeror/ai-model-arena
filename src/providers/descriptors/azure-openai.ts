import type { ProviderDescriptor } from '../types.js';
export const azureOpenAI: ProviderDescriptor = {
  id: 'azure-openai', name: 'Azure OpenAI', apiBase: 'https://{resource}.openai.azure.com/openai/v1',
  authScheme: 'bearer', envVar: 'AZURE_OPENAI_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
