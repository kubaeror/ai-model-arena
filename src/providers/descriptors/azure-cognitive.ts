import type { ProviderDescriptor } from '../types.js';
export const azureCognitive: ProviderDescriptor = {
  id: 'azure-cognitive-services', name: 'Azure Cognitive Services', apiBase: 'https://{resource}.cognitiveservices.azure.com/openai/v1',
  authScheme: 'bearer', envVar: 'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME', adapter: 'openai-compat', isBuiltin: true,
};
