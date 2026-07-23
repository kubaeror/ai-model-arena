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
import { codestral } from './descriptors/codestral.js';
import { zai } from './descriptors/zai.js';
import { dashscope } from './descriptors/dashscope.js';
import { ovhcloud } from './descriptors/ovhcloud.js';
import { opencodeZen } from './descriptors/opencode-zen.js';
import { kilo } from './descriptors/kilo.js';
import { llm7 } from './descriptors/llm7.js';
import { routeway } from './descriptors/routeway.js';
import { novita } from './descriptors/novita.js';
import { ollamaCloud } from './descriptors/ollama-cloud.js';
import { ai302 } from './descriptors/302ai.js';
import { azureOpenAI } from './descriptors/azure-openai.js';
import { baseten } from './descriptors/baseten.js';
import { cloudflareAIGateway } from './descriptors/cloudflare-ai-gateway.js';
import { cortecs } from './descriptors/cortecs.js';
import { deepseek } from './descriptors/deepseek.js';
import { deepinfra } from './descriptors/deepinfra.js';
import { digitalocean } from './descriptors/digitalocean.js';
import { frogbot } from './descriptors/frogbot.js';
import { fireworks } from './descriptors/fireworks.js';
import { gmiCloud } from './descriptors/gmi-cloud.js';
import { huggingface } from './descriptors/huggingface.js';
import { helicone } from './descriptors/helicone.js';
import { ionet } from './descriptors/ionet.js';
import { moonshot } from './descriptors/moonshot.js';
import { minimax } from './descriptors/minimax.js';
import { nebius } from './descriptors/nebius.js';
import { llmgateway } from './descriptors/llmgateway.js';
import { stackit } from './descriptors/stackit.js';
import { together } from './descriptors/together.js';
import { venice } from './descriptors/venice.js';
import { vercelAIGateway } from './descriptors/vercel-ai-gateway.js';
import { zenmux } from './descriptors/zenmux.js';
import { snowflakeCortex } from './descriptors/snowflake-cortex.js';
import { googleVertex } from './descriptors/google-vertex.js';
import { lmstudio } from './descriptors/lmstudio.js';
import { llamacpp } from './descriptors/llamacpp.js';
import { atomicChat } from './descriptors/atomic-chat.js';
import { meta } from './descriptors/meta.js';
import { azureCognitive } from './descriptors/azure-cognitive.js';
import { sapAICore } from './descriptors/sap-ai-core.js';
import { gitlab } from './descriptors/gitlab.js';
import { cohere } from './descriptors/cohere.js';
import { perplexity } from './descriptors/perplexity.js';

export const BUILTIN_PROVIDERS: ProviderDescriptor[] = [
  openai, anthropic, google, bedrock, openrouter, groq, cerebras, nvidia,
  mistral, sambanova, scaleway, cloudflare, githubCopilot, xai, ollama,
  codestral, zai, dashscope, ovhcloud, opencodeZen, kilo, llm7, routeway, novita, ollamaCloud,
  ai302, azureOpenAI, baseten, cloudflareAIGateway, cortecs, deepseek, deepinfra, digitalocean,
  frogbot, fireworks, gmiCloud, huggingface, helicone, ionet, moonshot, minimax, nebius,
  llmgateway, stackit, together, venice, vercelAIGateway, zenmux, snowflakeCortex, googleVertex,
  lmstudio, llamacpp, atomicChat,
  meta, azureCognitive, sapAICore, gitlab, cohere, perplexity,
];

export function loadBuiltins(reg: ProviderRegistry): void {
  reg.loadBuiltins(BUILTIN_PROVIDERS);
}

export { ProviderRegistry } from './registry.js';
export type { ProviderDescriptor, AdapterKind, AuthScheme } from './types.js';
export type { CreateAdapterOpts } from './registry.js';
