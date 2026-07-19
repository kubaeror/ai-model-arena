import type { ChatMessage, ModelResponse, ToolDefinition, TokenUsage, Logger } from '../types.js';
import type { ModelConfig } from '../config.js';
import { BaseAdapter, HttpError } from './base.js';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string | null;
  /** Path appended to baseUrl; default '/chat/completions'. */
  path?: string;
}

/** Convert the provider-agnostic ChatMessage[] into OpenAI chat messages. */
export function buildOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'system') return { role: 'system', content: m.content ?? '' };
    if (m.role === 'user') return { role: 'user', content: m.content ?? '' };
    if (m.role === 'assistant') {
      const obj: Record<string, unknown> = { role: 'assistant' };
      if (m.content) obj.content = m.content;
      if (m.toolCalls && m.toolCalls.length) {
        obj.tool_calls = m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.arguments) },
        }));
      }
      return obj;
    }
    // role === 'tool'
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' };
  });
}

/** Convert tool defs into OpenAI function-calling tool descriptors. */
export function buildOpenAITools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return typeof p === 'object' && p ? (p as Record<string, unknown>) : { _raw: raw };
    } catch {
      return { _raw: raw };
    }
  }
  return {};
}

/** Parse an OpenAI Chat Completions response into a normalised ModelResponse. */
export function parseOpenAIResponse(data: any): ModelResponse {
  const choice = data?.choices?.[0];
  const msg = choice?.message ?? {};
  const text = msg.content ?? null;
  const toolCalls = (msg.tool_calls ?? [])
    .map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: safeParseArgs(tc.function?.arguments),
    }))
    .filter((tc: any) => tc.id && tc.name);
  const usage: TokenUsage = {
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  };
  return { text, toolCalls, usage, stopReason: choice?.finish_reason, raw: data };
}

/**
 * Shared call to any OpenAI-compatible /chat/completions endpoint.
 * Used by both OpenAIAdapter and the local Ollama adapter.
 */
export async function callOpenAICompatible(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  opts: OpenAICompatibleOptions,
): Promise<ModelResponse> {
  const url = opts.baseUrl.replace(/\/+$/, '') + (opts.path ?? '/chat/completions');
  const body: Record<string, unknown> = {
    model: config.model,
    messages: buildOpenAIMessages(messages),
    temperature: config.temperature,
    max_tokens: config.maxTokens,
  };
  if (tools.length) {
    body.tools = buildOpenAITools(tools);
    body.tool_choice = 'auto'; // only send when tools are present (some servers reject it otherwise)
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    let retryAfterMs: number | undefined;
    const ra = res.headers.get('retry-after');
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs)) retryAfterMs = secs * 1000;
    }
    throw new HttpError(res.status, text, retryAfterMs);
  }
  const data = await res.json();
  return parseOpenAIResponse(data);
}

/** OpenAI Chat Completions adapter with function calling. */
export class OpenAIAdapter extends BaseAdapter {
  protected opts: OpenAICompatibleOptions;

  constructor(config: ModelConfig, logger?: Logger) {
    super(config, logger);
    const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : process.env.OPENAI_API_KEY;
    this.opts = {
      baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
      apiKey: apiKey ?? null,
    };
  }

  async sendMessage(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelResponse> {
    return this.withRetry(() => callOpenAICompatible(messages, tools, this.config, this.opts));
  }
}
