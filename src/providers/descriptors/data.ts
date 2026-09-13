import type { ProviderDescriptor } from '../types.js';

/**
 * Built-in provider descriptors, consolidated from what used to be one
 * file per provider. Static data only — keep entries in the original order.
 */
export const DESCRIPTOR_SPECS: readonly ProviderDescriptor[] = [
  {
    id: 'openai', name: 'OpenAI', apiBase: 'https://api.openai.com/v1',
    authScheme: 'bearer', envVar: 'OPENAI_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'anthropic', name: 'Anthropic', apiBase: 'https://api.anthropic.com',
    authScheme: 'x-api-key', envVar: 'ANTHROPIC_API_KEY', adapter: 'anthropic', isBuiltin: true,
  },
  {
    id: 'google', name: 'Google AI Studio', apiBase: 'https://generativelanguage.googleapis.com',
    authScheme: 'google', envVar: 'GOOGLE_API_KEY', adapter: 'google', isBuiltin: true,
  },
  {
    id: 'amazon-bedrock', name: 'Amazon Bedrock', authScheme: 'bedrock',
    envVar: 'AWS_BEDROCK_REGION', adapter: 'bedrock', isBuiltin: true,
  },
  {
    id: 'openrouter', name: 'OpenRouter', apiBase: 'https://openrouter.ai/api/v1',
    authScheme: 'bearer', envVar: 'OPENROUTER_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'groq', name: 'Groq', apiBase: 'https://api.groq.com/openai/v1',
    authScheme: 'bearer', envVar: 'GROQ_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'cerebras', name: 'Cerebras', apiBase: 'https://api.cerebras.ai/v1',
    authScheme: 'bearer', envVar: 'CEREBRAS_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'nvidia', name: 'NVIDIA NIM', apiBase: 'https://integrate.api.nvidia.com/v1',
    authScheme: 'bearer', envVar: 'NVIDIA_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'mistral', name: 'Mistral La Plateforme', apiBase: 'https://api.mistral.ai/v1',
    authScheme: 'bearer', envVar: 'MISTRAL_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'sambanova', name: 'SambaNova', apiBase: 'https://api.sambanova.ai/v1',
    authScheme: 'bearer', envVar: 'SAMBANOVA_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'scaleway', name: 'Scaleway', apiBase: 'https://api.scaleway.ai/ai-apis/v1',
    authScheme: 'bearer', envVar: 'SCALEWAY_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'cloudflare', name: 'Cloudflare Workers AI', apiBase: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    authScheme: 'bearer', envVar: 'CLOUDFLARE_API_TOKEN', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'github-copilot', name: 'GitHub Copilot Models', apiBase: 'https://api.githubcopilot.com',
    authScheme: 'bearer', envVar: 'GITHUB_TOKEN', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'xai', name: 'xAI', apiBase: 'https://api.x.ai/v1',
    authScheme: 'bearer', envVar: 'XAI_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'ollama', name: 'Ollama (local)', apiBase: 'http://localhost:11434/v1',
    authScheme: 'none', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'codestral', name: 'Codestral', apiBase: 'https://api.mistral.ai/v1',
    authScheme: 'bearer', envVar: 'MISTRAL_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'zai', name: 'Z.AI', apiBase: 'https://api.z.ai/api/coding/paas/v4',
    authScheme: 'bearer', envVar: 'ZAI_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'dashscope', name: 'Alibaba DashScope', apiBase: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    authScheme: 'bearer', envVar: 'DASHSCOPE_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'ovhcloud', name: 'OVHcloud AI Endpoints', apiBase: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    authScheme: 'bearer', envVar: 'OVH_AI_ENDPOINTS_ACCESS_TOKEN', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'opencode-zen', name: 'OpenCode Zen', apiBase: 'https://opencode.ai/zen/v1',
    authScheme: 'bearer', envVar: 'OPENCODE_ZEN_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'kilo', name: 'Kilo', apiBase: 'https://api.kilo.ai/api/gateway',
    authScheme: 'none', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'llm7', name: 'LLM7', apiBase: 'https://api.llm7.io/v1',
    authScheme: 'bearer', envVar: 'LLM7_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'routeway', name: 'Routeway', apiBase: 'https://api.routeway.ai/v1',
    authScheme: 'bearer', envVar: 'ROUTEWAY_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'novita', name: 'Novita AI', apiBase: 'https://api.novita.ai/openai/v1',
    authScheme: 'bearer', envVar: 'NOVITA_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'ollama-cloud', name: 'Ollama Cloud', apiBase: 'https://ollama.com/v1',
    authScheme: 'bearer', envVar: 'OLLAMA_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: '302ai', name: '302.AI', apiBase: 'https://api.302.ai/v1',
    authScheme: 'bearer', envVar: 'AI302_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'azure-openai', name: 'Azure OpenAI', apiBase: 'https://{resource}.openai.azure.com/openai/v1',
    authScheme: 'bearer', envVar: 'AZURE_OPENAI_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'baseten', name: 'Baseten', apiBase: 'https://api.baseten.co/v1',
    authScheme: 'bearer', envVar: 'BASETEN_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway', apiBase: 'https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}',
    authScheme: 'bearer', envVar: 'CLOUDFLARE_API_TOKEN', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'cortecs', name: 'Cortecs', apiBase: 'https://api.cortecs.ai/v1',
    authScheme: 'bearer', envVar: 'CORTECS_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'deepseek', name: 'DeepSeek', apiBase: 'https://api.deepseek.com/v1',
    authScheme: 'bearer', envVar: 'DEEPSEEK_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'deepinfra', name: 'Deep Infra', apiBase: 'https://api.deepinfra.com/v1/openai',
    authScheme: 'bearer', envVar: 'DEEPINFRA_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'digitalocean', name: 'DigitalOcean Inference', apiBase: 'https://api.digitalocean.com/v1/genai',
    authScheme: 'bearer', envVar: 'DIGITALOCEAN_ACCESS_TOKEN', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'frogbot', name: 'FrogBot', apiBase: 'https://api.frogbot.ai/v1',
    authScheme: 'bearer', envVar: 'FROGBOT_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'fireworks', name: 'Fireworks AI', apiBase: 'https://api.fireworks.ai/inference/v1',
    authScheme: 'bearer', envVar: 'FIREWORKS_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'gmi-cloud', name: 'GMI Cloud', apiBase: 'https://api.gmicloud.ai/v1',
    authScheme: 'bearer', envVar: 'GMI_CLOUD_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'huggingface', name: 'Hugging Face', apiBase: 'https://api-inference.huggingface.co/v1',
    authScheme: 'bearer', envVar: 'HUGGINGFACE_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'helicone', name: 'Helicone', apiBase: 'https://ai-gateway.helicone.ai',
    authScheme: 'bearer', envVar: 'HELICONE_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'ionet', name: 'IO.NET', apiBase: 'https://api.io.net/v1',
    authScheme: 'bearer', envVar: 'IONET_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'moonshot', name: 'Moonshot AI', apiBase: 'https://api.moonshot.ai/v1',
    authScheme: 'bearer', envVar: 'MOONSHOT_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'minimax', name: 'MiniMax', apiBase: 'https://api.minimax.io/v1',
    authScheme: 'bearer', envVar: 'MINIMAX_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'nebius', name: 'Nebius Token Factory', apiBase: 'https://api.nebius.ai/v1',
    authScheme: 'bearer', envVar: 'NEBIUS_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'llmgateway', name: 'LLM Gateway', apiBase: 'https://api.llmgateway.io/v1',
    authScheme: 'bearer', envVar: 'LLMGATEWAY_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'stackit', name: 'STACKIT', apiBase: 'https://api.stackit.cloud/ai/v1',
    authScheme: 'bearer', envVar: 'STACKIT_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'together', name: 'Together AI', apiBase: 'https://api.together.xyz/v1',
    authScheme: 'bearer', envVar: 'TOGETHER_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'venice', name: 'Venice AI', apiBase: 'https://api.venice.ai/api/v1',
    authScheme: 'bearer', envVar: 'VENICE_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'vercel-ai-gateway', name: 'Vercel AI Gateway', apiBase: 'https://ai-gateway.vercel.sh/v1',
    authScheme: 'bearer', envVar: 'VERCEL_AI_GATEWAY_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'zenmux', name: 'ZenMux', apiBase: 'https://api.zenmux.ai/v1',
    authScheme: 'bearer', envVar: 'ZENMUX_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'snowflake-cortex', name: 'Snowflake Cortex', apiBase: 'https://{account}.snowflakecomputing.com/api/v2/cortex/inference/v1',
    authScheme: 'bearer', envVar: 'SNOWFLAKE_CORTEX_TOKEN', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'google-vertex', name: 'Google Vertex AI', apiBase: 'https://{location}-aiplatform.googleapis.com/v1',
    authScheme: 'google', envVar: 'GOOGLE_CLOUD_PROJECT', adapter: 'google', isBuiltin: true,
  },
  {
    id: 'lmstudio', name: 'LM Studio (local)', apiBase: 'http://127.0.0.1:1234/v1',
    authScheme: 'none', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'llamacpp', name: 'llama.cpp (local)', apiBase: 'http://127.0.0.1:8080/v1',
    authScheme: 'none', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'atomic-chat', name: 'Atomic Chat (local)', apiBase: 'http://127.0.0.1:1337/v1',
    authScheme: 'none', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'meta', name: 'Meta AI', apiBase: 'https://api.meta.ai/v1',
    authScheme: 'bearer', envVar: 'META_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'azure-cognitive-services', name: 'Azure Cognitive Services', apiBase: 'https://{resource}.cognitiveservices.azure.com/openai/v1',
    authScheme: 'bearer', envVar: 'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'sap-ai-core', name: 'SAP AI Core', apiBase: 'https://{instance}.ai.core.sap/v1',
    authScheme: 'bearer', envVar: 'AICORE_SERVICE_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'cohere', name: 'Cohere', apiBase: 'https://api.cohere.ai/v1',
    authScheme: 'bearer', envVar: 'COHERE_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
  {
    id: 'perplexity', name: 'Perplexity', apiBase: 'https://api.perplexity.ai',
    authScheme: 'bearer', envVar: 'PERPLEXITY_API_KEY', adapter: 'openai-compat', isBuiltin: true,
  },
];
