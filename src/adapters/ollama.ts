import type { ModelConfig } from '../config.js';
import type { ToolDefinition, ModelResponse, ChatMessage, Logger } from '../types.js';
import { BaseAdapter } from './base.js';
import { callOpenAICompatible } from './openai.js';

/**
 * Generic OpenAI-compatible adapter for local model servers (Ollama, LM Studio,
 * vLLM, etc.). These servers expose the OpenAI Chat Completions schema at a
 * configurable base URL. Function calling support depends on the server/model;
 * Ollama's OpenAI-compatible endpoint supports tools for many models.
 */
export class OllamaAdapter extends BaseAdapter {
  protected opts: { baseUrl: string; apiKey: string | null };

  constructor(config: ModelConfig, logger?: Logger) {
    super(config, logger);
    const apiKey = config.apiKeyEnv
      ? process.env[config.apiKeyEnv] ?? null
      : process.env.OLLAMA_API_KEY ?? 'ollama';
    this.opts = {
      baseUrl: config.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
      apiKey: apiKey ?? null,
    };
  }

  async sendMessage(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelResponse> {
    return this.withRetry(() => callOpenAICompatible(messages, tools, this.config, this.opts));
  }
}
