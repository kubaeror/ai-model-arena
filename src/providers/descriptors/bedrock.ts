import type { ProviderDescriptor } from '../types.js';
export const bedrock: ProviderDescriptor = {
  id: 'amazon-bedrock', name: 'Amazon Bedrock', authScheme: 'bedrock',
  envVar: 'AWS_BEDROCK_REGION', adapter: 'bedrock', isBuiltin: true,
  capabilities: {
    streaming: true,
    tools: true,
    structuredOutput: false,
    reasoning: false,
    promptCaching: false,
    vision: false,
  },
};
