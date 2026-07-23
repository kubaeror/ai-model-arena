import type { ProviderDescriptor } from '../types.js';
export const gitlab: ProviderDescriptor = {
  id: 'gitlab', name: 'GitLab Duo', apiBase: 'https://gitlab.com/api/v4/ai',
  authScheme: 'bearer', envVar: 'GITLAB_TOKEN', adapter: 'openai-compat', isBuiltin: true,
};
