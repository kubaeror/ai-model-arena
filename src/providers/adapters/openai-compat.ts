import type { ChatMessage, ModelResponse, ToolDefinition } from '../../types.js';
import type { ModelAdapter, SendOpts } from './base.js';
import { BaseAdapter, DEFAULT_RETRY, throwForStatus } from './base.js';
import type { ProviderDescriptor } from '../types.js';
import type { CreateAdapterOpts } from '../registry.js';
import { buildOpenAIBody, parseOpenAIResponse, type OpenAIResponse } from './openai-shared.js';

export class OpenAICompatAdapter extends BaseAdapter implements ModelAdapter {
  private descriptor: ProviderDescriptor;
  private modelId: string;
  private apiKey?: string;
  private baseUrl?: string;

  constructor(descriptor: ProviderDescriptor, modelId: string, opts: CreateAdapterOpts) {
    super(opts.logger);
    this.descriptor = descriptor;
    this.modelId = modelId;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? descriptor.apiBase;
    this.providerLabel = descriptor.id;
    // Fail fast on unconfigured placeholder URLs (e.g. azure-openai's
    // https://{resource}.openai.azure.com/openai/v1) instead of POSTing to a
    // literal '{resource}' hostname and failing with a confusing DNS error.
    if (/\{/.test(this.baseUrl ?? '')) {
      throw new Error(
        `Provider "${descriptor.id}" has an unconfigured baseUrl "${this.baseUrl}". ` +
        `Set a concrete baseUrl in the provider settings (replace {resource}/{instance} placeholders).`,
      );
    }
  }

  supportsReasoning(): boolean { return true; }
  supportsPromptCaching(): boolean { return true; }

  async sendMessage(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse> {
    return this.withRetry(() => this.timed(async () => {
      const body = buildOpenAIBody(this.modelId, messages, tools, opts);
      const res = await this.fetchEndpoint('/chat/completions', body);
      await throwForStatus(res, 'OpenAI-compat');
      const json = (await res.json()) as OpenAIResponse;
      return parseOpenAIResponse(json);
    }), DEFAULT_RETRY);
  }

  private async fetchEndpoint(path: string, body: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.descriptor.authScheme === 'bearer' && this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.descriptor.authScheme === 'x-api-key' && this.apiKey) {
      // headerName defaults to x-api-key so x-api-key schemes never silently
      // send no auth header at all.
      headers[this.descriptor.headerName ?? 'x-api-key'] = this.apiKey;
    } else if (this.descriptor.headerName && this.apiKey) {
      headers[this.descriptor.headerName] = this.apiKey;
    }
    return this.post(`${this.baseUrl}${path}`, body, headers);
  }
}
