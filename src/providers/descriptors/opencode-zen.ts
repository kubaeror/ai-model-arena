import type { ProviderDescriptor } from '../types.js';
export const opencodeZen: ProviderDescriptor = {
  id: 'opencode-zen', name: 'OpenCode Zen', apiBase: 'https://opencode.ai/zen/v1',
  authScheme: 'bearer', envVar: 'OPENCODE_ZEN_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
