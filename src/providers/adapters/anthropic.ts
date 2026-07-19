import type { ModelAdapter } from './base.js';
import type { ProviderDescriptor } from '../types.js';
import type { CreateAdapterOpts } from '../registry.js';

export class AnthropicAdapter implements ModelAdapter {
  constructor(_descriptor: ProviderDescriptor, _modelId: string, _opts: CreateAdapterOpts) {}
  supportsStreaming(): boolean { return false; }
  supportsReasoning(): boolean { return false; }
  supportsPromptCaching(): boolean { return false; }
  async sendMessage(): Promise<never> { throw new Error('AnthropicAdapter not implemented'); }
}
