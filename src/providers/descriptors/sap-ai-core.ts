import type { ProviderDescriptor } from '../types.js';
export const sapAICore: ProviderDescriptor = {
  id: 'sap-ai-core', name: 'SAP AI Core', apiBase: 'https://{instance}.ai.core.sap/v1',
  authScheme: 'bearer', envVar: 'AICORE_SERVICE_KEY', adapter: 'openai-compat', isBuiltin: true,
};
