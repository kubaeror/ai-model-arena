import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleAdapter } from '../../src/providers/adapters/google.js';
import type { ProviderDescriptor } from '../../src/providers/types.js';

const vertexDescriptor: ProviderDescriptor = {
  id: 'google-vertex', name: 'Google Vertex', apiBase: 'https://{location}-aiplatform.googleapis.com',
  authScheme: 'google', envVar: 'GOOGLE_API_KEY', adapter: 'google', isBuiltin: true,
};

test('GoogleAdapter refuses unconfigured placeholder base URLs', () => {
  assert.throws(
    () => new GoogleAdapter(vertexDescriptor, 'gemini-2.0-flash', { apiKey: 'k' }),
    /unconfigured baseUrl/,
  );
});

test('GoogleAdapter accepts a concrete base URL', () => {
  const desc: ProviderDescriptor = {
    ...vertexDescriptor, apiBase: 'https://us-central1-aiplatform.googleapis.com',
  };
  const adapter = new GoogleAdapter(desc, 'gemini-2.0-flash', { apiKey: 'k' });
  assert.ok(adapter);
});
