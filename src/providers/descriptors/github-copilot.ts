import type { ProviderDescriptor } from '../types.js';
export const githubCopilot: ProviderDescriptor = {
  id: 'github-copilot', name: 'GitHub Copilot Models', apiBase: 'https://api.githubcopilot.com',
  authScheme: 'bearer', envVar: 'GITHUB_TOKEN', adapter: 'openai-compat', isBuiltin: true,
};
