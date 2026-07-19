import type { Logger } from '../types.js';
import type { ModelConfig } from '../config.js';
import type { ModelAdapter } from './base.js';
import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { OllamaAdapter } from './ollama.js';

export { BaseAdapter, HttpError } from './base.js';
export type { ModelAdapter } from './base.js';
export { OpenAIAdapter, buildOpenAIMessages, parseOpenAIResponse } from './openai.js';
export { AnthropicAdapter, buildAnthropicPayload, parseAnthropicResponse } from './anthropic.js';
export { OllamaAdapter } from './ollama.js';

/** Factory: build the right adapter from a model config. */
export function createAdapter(config: ModelConfig, logger?: Logger): ModelAdapter {
  switch (config.provider) {
    case 'openai':
      return new OpenAIAdapter(config, logger);
    case 'anthropic':
      return new AnthropicAdapter(config, logger);
    case 'ollama':
    case 'openai-compatible':
      return new OllamaAdapter(config, logger);
    case 'google':
      throw new Error(
        'Google adapter not implemented yet. See src/adapters/README.md (README.md "Adding a new adapter").',
      );
    default:
      throw new Error(`Unknown provider: ${String((config as ModelConfig).provider)}`);
  }
}
