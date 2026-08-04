import type { ChatMessage, ModelResponse, ToolCall, TokenUsage, ToolDefinition } from '../../types.js';
import type { ModelAdapter, SendOpts } from './base.js';
import { BaseAdapter, HttpError } from './base.js';
import type { ProviderDescriptor } from '../types.js';
import type { CreateAdapterOpts } from '../registry.js';

interface GeminiPart { text?: string; functionCall?: { name: string; args: Record<string, unknown> } }
interface GeminiCandidate { content: { parts: GeminiPart[] }; finishReason?: string }
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; cachedContentTokenCount?: number };
}

export class GoogleAdapter extends BaseAdapter implements ModelAdapter {
  private modelId: string;
  private apiKey?: string;
  private baseUrl?: string;

  constructor(descriptor: ProviderDescriptor, modelId: string, opts: CreateAdapterOpts) {
    super(opts.logger);
    this.modelId = modelId;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? descriptor.apiBase;
  }

  supportsStreaming(): boolean { return false; }
  supportsReasoning(): boolean { return true; }
  supportsPromptCaching(): boolean { return true; }

  async sendMessage(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse> {
    return this.withRetry(async () => {
      const body = this.buildBody(messages, tools, opts);
      const url = `${this.baseUrl}/v1beta/models/${this.modelId}:generateContent?key=${this.apiKey ?? ''}`;
      const res = await this.post(url, body);
      if (!res.ok) {
        const text = await res.text();
        throw new HttpError(res.status, text, `Google ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as GeminiResponse;
      return this.parseResponse(json);
    }, { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 30000 });
  }

  private buildBody(messages: ChatMessage[], tools: ToolDefinition[], opts: SendOpts | undefined): Record<string, unknown> {
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: m.toolCalls?.length
          ? m.toolCalls.map(tc => ({ functionCall: { name: tc.name, args: tc.arguments } }))
          : m.role === 'tool'
            ? [{ functionResponse: { name: m.name ?? '', response: { content: m.content ?? '' } } }]
            : [{ text: m.content ?? '' }],
      }));
    const system = messages.filter(m => m.role === 'system').map(m => m.content ?? '').join('\n');
    const body: Record<string, unknown> = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools.length > 0) {
      body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    }
    if (opts?.temperature !== undefined) {
      const gc = (body.generationConfig ?? {}) as Record<string, unknown>;
      gc.temperature = opts.temperature;
      body.generationConfig = gc;
    }
    if (opts?.maxTokens !== undefined) {
      const gc = (body.generationConfig ?? {}) as Record<string, unknown>;
      gc.maxOutputTokens = opts.maxTokens;
      body.generationConfig = gc;
    }
    return body;
  }

  private parseResponse(json: GeminiResponse): ModelResponse {
    const candidate = json.candidates?.[0];
    const parts = candidate?.content.parts ?? [];
    const text = parts.map(p => p.text ?? '').join('') || null;
    const toolCalls: ToolCall[] = parts
      .filter(p => p.functionCall)
      .map(p => ({ id: `google_${p.functionCall!.name}`, name: p.functionCall!.name, arguments: p.functionCall!.args ?? {} }));
    const usage: TokenUsage = {
      prompt: json.usageMetadata?.promptTokenCount,
      completion: json.usageMetadata?.candidatesTokenCount,
      total: json.usageMetadata?.totalTokenCount,
      cacheReadTokens: json.usageMetadata?.cachedContentTokenCount,
    };
    return { text, toolCalls, usage, stopReason: candidate?.finishReason, raw: json };
  }
}
