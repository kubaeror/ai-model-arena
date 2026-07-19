import type { ProviderDescriptor } from '../types.js';
export const google: ProviderDescriptor = {
  id: 'google', name: 'Google AI Studio', apiBase: 'https://generativelanguage.googleapis.com',
  authScheme: 'google', envVar: 'GOOGLE_API_KEY', adapter: 'google', isBuiltin: true,
};
