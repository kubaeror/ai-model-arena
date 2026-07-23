import type { ProviderDescriptor } from '../types.js';
export const googleVertex: ProviderDescriptor = {
  id: 'google-vertex', name: 'Google Vertex AI', apiBase: 'https://{location}-aiplatform.googleapis.com/v1',
  authScheme: 'google', envVar: 'GOOGLE_CLOUD_PROJECT', adapter: 'google', isBuiltin: true,
};
