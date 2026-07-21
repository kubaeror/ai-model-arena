import type { ChatMessage, ModelResponse, ToolCall, TokenUsage, ToolDefinition } from '../../types.js';
import type { ModelAdapter, SendOpts, StreamChunk } from './base.js';
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
  }

  supportsStreaming(): boolean { return true; }
  supportsReasoning(): boolean { return true; }
  supportsPromptCaching(): boolean { return true; }

  buildCacheBreakpoints(messages: ChatMessage[]): ChatMessage[] {
    // OpenAI auto-caches; no explicit breakpoints needed.
    return messages;
  }

  async sendMessage(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse> {
    return this.withRetry(async () => {
      const body = this.buildBody(messages, tools, opts, false);
      const res = await this.fetchEndpoint('/chat/completions', body);
      if (!res.ok) {
        const text = await res.text();
        throw new HttpError(res.status, text, `OpenAI-compat ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as OpenAIResponse;
      return this.parseResponse(json);
    }, { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 30000 });
  }

  async *sendMessageStream(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): AsyncIterable<StreamChunk> {
    const body = this.buildBody(messages, tools, opts, true);
    const res = await this.fetchEndpoint('/chat/completions', body);
    if (!res.ok || !res.body) {
      const text = await res.text();
      throw new HttpError(res.status, text, `OpenAI-compat stream ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const evt = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
          };
          const delta = evt.choices?.[0]?.delta;
          if (delta?.content) yield { text: delta.content };
          if (delta?.tool_calls?.length) {
            for (const tc of delta.tool_calls) {
              yield { toolCallDelta: { id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments } };
            }
          }
          if (evt.choices?.[0]?.finish_reason) yield { finishReason: evt.choices[0].finish_reason };
          if (evt.usage) {
            yield {
              usage: { prompt: evt.usage.prompt_tokens, completion: evt.usage.completion_tokens, total: evt.usage.total_tokens },
              cacheReadTokens: evt.usage.prompt_tokens_details?.cached_tokens,
            };
          }
        } catch { /* skip non-JSON */ }
      }
    }
  }

  private buildBody(messages: ChatMessage[], tools: ToolDefinition[], opts: SendOpts | undefined, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls ? { tool_calls: m.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.name ? { name: m.name } : {}),
      })),
      stream,
    };
    if (tools.length > 0) {
      body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.reasoning && opts.reasoning.type === 'effort') {
      body.reasoning_effort = opts.reasoning.value ?? 'medium';
    }
    return body;
  }

  private async fetchEndpoint(path: string, body: Record<string, unknown>): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.descriptor.authScheme === 'bearer' && this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.descriptor.headerName && this.apiKey) headers[this.descriptor.headerName] = this.apiKey;
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  }

  private parseResponse(json: OpenAIResponse): ModelResponse {
    const choice = json.choices[0];
    if (!choice) {
      return { text: null, toolCalls: [], usage: {}, stopReason: undefined, raw: json };
    }
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map(tc => ({
      id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments || '{}'),
    }));
    const usage: TokenUsage = {
      prompt: json.usage?.prompt_tokens,
      completion: json.usage?.completion_tokens,
      total: json.usage?.total_tokens,
      cacheReadTokens: json.usage?.prompt_tokens_details?.cached_tokens,
    };
    return { text: choice.message.content ?? null, toolCalls, usage, stopReason: choice.finish_reason, raw: json };
  }
}
