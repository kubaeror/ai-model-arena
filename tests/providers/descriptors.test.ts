import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PROVIDERS } from '../../src/providers/index.js';
import { isBlockedProviderHost } from '../../src/providers/url-validator.js';

/**
 * Descriptors whose apiBase contains a per-account/location template placeholder
 * (`{...}`) that the adapter resolves at runtime. Everything else must be a
 * fully-qualified, request-ready URL.
 */
const TEMPLATE_ALLOWLIST = new Set([
  'azure-openai',
  'azure-cognitive-services',
  'cloudflare-ai-gateway',
  'sap-ai-core',
  'snowflake-cortex',
  'google-vertex',
  'cloudflare',
]);

/**
 * Local dev endpoints are intentionally plain HTTP against loopback addresses
 * and are exempt from the https / blocked-host rules.
 */
const LOCAL_ALLOWLIST = new Set(['ollama', 'llamacpp', 'lmstudio', 'atomic-chat']);

/** Every builtin provider that must be registered, in alphabetical order. */
const EXPECTED_IDS = [
  '302ai',
  'amazon-bedrock',
  'anthropic',
  'atomic-chat',
  'azure-cognitive-services',
  'azure-openai',
  'baseten',
  'cerebras',
  'cloudflare',
  'cloudflare-ai-gateway',
  'codestral',
  'cohere',
  'cortecs',
  'dashscope',
  'deepinfra',
  'deepseek',
  'digitalocean',
  'fireworks',
  'frogbot',
  'github-copilot',
  'gmi-cloud',
  'google',
  'google-vertex',
  'groq',
  'helicone',
  'huggingface',
  'ionet',
  'kilo',
  'llamacpp',
  'llm7',
  'llmgateway',
  'lmstudio',
  'meta',
  'minimax',
  'mistral',
  'moonshot',
  'nebius',
  'novita',
  'nvidia',
  'ollama',
  'ollama-cloud',
  'openai',
  'opencode-zen',
  'openrouter',
  'ovhcloud',
  'perplexity',
  'routeway',
  'sambanova',
  'sap-ai-core',
  'scaleway',
  'snowflake-cortex',
  'stackit',
  'together',
  'venice',
  'vercel-ai-gateway',
  'xai',
  'zai',
  'zenmux',
];

test('builtin descriptors match the expected id list exactly', () => {
  const ids = BUILTIN_PROVIDERS.map(d => d.id).sort();
  assert.deepEqual(ids, [...EXPECTED_IDS].sort());
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
});

test('builtin descriptor ids are unique', () => {
  const ids = BUILTIN_PROVIDERS.map(d => d.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('builtin apiBase URLs parse as https with no blocked hosts', () => {
  for (const d of BUILTIN_PROVIDERS) {
    if (!d.apiBase) continue;
    const url = new URL(d.apiBase); // throws if unparseable
    if (!LOCAL_ALLOWLIST.has(d.id)) {
      assert.equal(url.protocol, 'https:', `${d.id}: apiBase must use https`);
      assert.equal(isBlockedProviderHost(url.hostname), false, `${d.id}: hostname ${url.hostname} is blocked`);
    }
    if (TEMPLATE_ALLOWLIST.has(d.id)) {
      assert.ok(d.apiBase.includes('{'), `${d.id}: apiBase must contain a template placeholder`);
    } else {
      assert.ok(!d.apiBase.includes('{'), `${d.id}: apiBase must not contain a template placeholder`);
    }
  }
});

test('builtin descriptors have a valid non-empty env var when auth requires a key', () => {
  const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]+$/;
  for (const d of BUILTIN_PROVIDERS) {
    if (d.authScheme !== 'none') {
      assert.ok(d.envVar && d.envVar.length > 0, `${d.id}: envVar required for authScheme ${d.authScheme}`);
      assert.match(d.envVar, ENV_VAR_NAME, `${d.id}: envVar "${d.envVar}" is not a valid env var name`);
    } else if (d.envVar) {
      assert.match(d.envVar, ENV_VAR_NAME, `${d.id}: envVar "${d.envVar}" is not a valid env var name`);
    }
  }
});
