import type { ChatMessage, ModelResponse, ToolCall, TokenUsage, ToolDefinition } from '../../types.js';
import type { ModelAdapter, SendOpts } from './base.js';
import { BaseAdapter, HttpError } from './base.js';
import type { ProviderDescriptor } from '../types.js';
import type { CreateAdapterOpts } from '../registry.js';

interface OpenAIChoice {
  message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
  finish_reason: string;
}
interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

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
    return this.withRetry(async () => {
      const body = this.buildBody(messages, tools, opts);
      const res = await this.fetchEndpoint('/chat/completions', body);
      if (!res.ok) {
        const text = await res.text();
        throw new HttpError(res.status, text, `OpenAI-compat ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as OpenAIResponse;
      return this.parseResponse(json);
    }, { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 30000 });
  }

  private buildBody(messages: ChatMessage[], tools: ToolDefinition[], opts: SendOpts | undefined): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls ? { tool_calls: m.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.name ? { name: m.name } : {}),
      })),
    };
    if (tools.length > 0) {
      body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    return body;
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

  private parseResponse(json: OpenAIResponse): ModelResponse {
    const choice = json.choices[0];
    if (!choice) {
      return { text: null, toolCalls: [], usage: {}, stopReason: undefined, raw: json };
    }
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map(tc => {
      // Some providers return non-JSON arguments strings; do not let a
      // SyntaxError escape the retry wrapper and kill the whole run.
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>; } catch { args = {}; }
      return { id: tc.id, name: tc.function.name, arguments: args };
    });
    const usage: TokenUsage = {
      prompt: json.usage?.prompt_tokens,
      completion: json.usage?.completion_tokens,
      total: json.usage?.total_tokens,
      cacheReadTokens: json.usage?.prompt_tokens_details?.cached_tokens,
    };
    return { text: choice.message.content ?? null, toolCalls, usage, stopReason: choice.finish_reason, raw: json };
  }
}
