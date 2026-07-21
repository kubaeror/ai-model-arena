import type { ChatMessage, ModelResponse, ToolCall, TokenUsage, ToolDefinition } from '../../types.js';
import type { ModelAdapter, SendOpts, StreamChunk } from './base.js';
import { BaseAdapter, HttpError } from './base.js';
import type { ProviderDescriptor } from '../types.js';
import type { CreateAdapterOpts } from '../registry.js';

interface AnthropicContent { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }
interface AnthropicResponse {
  id: string; role: string; content: AnthropicContent[]; stop_reason: string;
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

const MAX_CACHE_BREAKPOINTS = 4;

export class AnthropicAdapter extends BaseAdapter implements ModelAdapter {
  private modelId: string;
  private apiKey?: string;
  private baseUrl?: string;

  constructor(descriptor: ProviderDescriptor, modelId: string, opts: CreateAdapterOpts) {
    super(opts.logger);
    this.modelId = modelId;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? descriptor.apiBase;
  }

  supportsStreaming(): boolean { return true; }
  supportsReasoning(): boolean { return true; }
  supportsPromptCaching(): boolean { return true; }

  buildCacheBreakpoints(messages: ChatMessage[]): ChatMessage[] {
    // cache_control markers are applied inside buildBody; this method satisfies the interface contract.
    return messages;
  }

  async sendMessage(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse> {
    return this.withRetry(async () => {
      const body = this.buildBody(messages, tools, opts, false);
      const res = await this.fetchEndpoint('/v1/messages', body);
      if (!res.ok) {
        const text = await res.text();
        throw new HttpError(res.status, text, `Anthropic ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as AnthropicResponse;
      return this.parseResponse(json);
    }, { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 30000 });
  }

  async *sendMessageStream(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): AsyncIterable<StreamChunk> {
    const body = this.buildBody(messages, tools, opts, true);
    const res = await this.fetchEndpoint('/v1/messages', body);
    if (!res.ok || !res.body) {
      const text = await res.text();
      throw new HttpError(res.status, text, `Anthropic stream ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split('\n');
      buf = events.pop() ?? '';
      for (const line of events) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        try {
          const evt = JSON.parse(data) as {
            type?: string;
            delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
            message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
          };
          if (evt.type === 'content_block_delta' && evt.delta?.text) yield { text: evt.delta.text };
          if (evt.type === 'message_delta' && evt.delta?.stop_reason) yield { finishReason: evt.delta.stop_reason };
          if (evt.type === 'message_start' && evt.message?.usage) {
            const u = evt.message.usage;
            yield {
              usage: { prompt: u.input_tokens, completion: u.output_tokens },
              cacheReadTokens: u.cache_read_input_tokens,
              cacheWriteTokens: u.cache_creation_input_tokens,
            };
          }
        } catch { /* skip */ }
      }
    }
  }

  private buildBody(messages: ChatMessage[], tools: ToolDefinition[], opts: SendOpts | undefined, stream: boolean): Record<string, unknown> {
    let system: string | undefined;
    const conversational: Array<Record<string, unknown>> = [];
    const cacheIndices = new Set<number>();
    let targetCount = 0;
    for (let i = messages.length - 1; i >= 0 && targetCount < MAX_CACHE_BREAKPOINTS; i--) {
      const m = messages[i];
      if (!m) continue;
      if (m.role === 'system' || m.role === 'user') {
        cacheIndices.add(i);
        targetCount++;
      }
    }
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m) continue;
      if (m.role === 'system') {
        system = (system ?? '') + (m.content ?? '');
        continue;
      }
      const role = m.role === 'tool' ? 'user' : m.role;
      const content: Array<Record<string, unknown>> = [];
      if (m.role === 'assistant' && m.toolCalls?.length) {
        for (const tc of m.toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        if (m.content) content.unshift({ type: 'text', text: m.content });
      } else if (m.role === 'tool') {
        content.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content ?? '' });
      } else {
        content.push({ type: 'text', text: m.content ?? '' });
      }
      const block: Record<string, unknown> = { role };
      if (cacheIndices.has(i)) {
        block.content = content.map((c, idx) => idx === content.length - 1 ? { ...c, cache_control: { type: 'ephemeral' } } : c);
      } else {
        block.content = content;
      }
      conversational.push(block);
    }
    const body: Record<string, unknown> = {
      model: this.modelId,
      max_tokens: opts?.maxTokens ?? 4096,
      messages: conversational,
      stream,
    };
    if (system) body.system = system;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (tools.length > 0) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (opts?.reasoning && opts.reasoning.type === 'budget_tokens') {
      body.thinking = { type: 'enabled', budget_tokens: typeof opts.reasoning.value === 'number' ? opts.reasoning.value : 4096 };
    }
    return body;
  }

  private async fetchEndpoint(path: string, body: Record<string, unknown>): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  }

  private parseResponse(json: AnthropicResponse): ModelResponse {
    let text: string | null = null;
    const toolCalls: ToolCall[] = [];
    for (const block of json.content) {
      if (block.type === 'text' && block.text !== undefined) {
        text = (text ?? '') + block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id ?? '', name: block.name ?? '', arguments: block.input ?? {} });
      }
    }
    const usage: TokenUsage = {
      prompt: json.usage.input_tokens,
      completion: json.usage.output_tokens,
      cacheReadTokens: json.usage.cache_read_input_tokens,
      cacheWriteTokens: json.usage.cache_creation_input_tokens,
    };
    return { text, toolCalls, usage, stopReason: json.stop_reason, raw: json };
  }
}
