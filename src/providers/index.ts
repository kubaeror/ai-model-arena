import type { ProviderRegistry } from './registry.js';
import type { ProviderDescriptor } from './types.js';
import { openai } from './descriptors/openai.js';
import { anthropic } from './descriptors/anthropic.js';
import { google } from './descriptors/google.js';
import { bedrock } from './descriptors/bedrock.js';
import { openrouter } from './descriptors/openrouter.js';
import { groq } from './descriptors/groq.js';
import { cerebras } from './descriptors/cerebras.js';
import { nvidia } from './descriptors/nvidia.js';
import { mistral } from './descriptors/mistral.js';
import { sambanova } from './descriptors/sambanova.js';
import { scaleway } from './descriptors/scaleway.js';
import { cloudflare } from './descriptors/cloudflare.js';
import { githubCopilot } from './descriptors/github-copilot.js';
import { xai } from './descriptors/xai.js';
import { ollama } from './descriptors/ollama.js';

export const BUILTIN_PROVIDERS: ProviderDescriptor[] = [
  openai, anthropic, google, bedrock, openrouter, groq, cerebras, nvidia,
  mistral, sambanova, scaleway, cloudflare, githubCopilot, xai, ollama,
];

export function loadBuiltins(reg: ProviderRegistry): void {
  reg.loadBuiltins(BUILTIN_PROVIDERS);
}

export { ProviderRegistry } from './registry.js';
export type { ProviderDescriptor, AdapterKind, AuthScheme } from './types.js';
export type { CreateAdapterOpts } from './registry.js';
