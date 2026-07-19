import type { ChatMessage, ModelResponse, ToolDefinition, TokenUsage, Logger } from '../types.js';
import type { ModelConfig } from '../config.js';
import { BaseAdapter, HttpError } from './base.js';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicBlock[] };

/**
 * Convert the provider-agnostic ChatMessage[] into Anthropic's Messages API
 * shape. Anthropic separates `system` out and requires tool results to live in
 * `user` messages as `tool_result` blocks. Consecutive tool results are merged
 * into a single user message, matching Anthropic's constraints.
 */
export function buildAnthropicPayload(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
): Record<string, unknown> {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  const lastIsToolResultOnly = (): boolean => {
    if (out.length === 0) return false;
    const last = out[out.length - 1]!;
    return last.role === 'user' && last.content.every((b) => b.type === 'tool_result');
  };

  const pushUserText = (text: string) => {
    if (lastIsToolResultOnly()) out[out.length - 1]!.content.push({ type: 'text', text });
    else out.push({ role: 'user', content: [{ type: 'text', text }] });
  };

  const pushToolResult = (toolUseId: string, content: string) => {
    if (lastIsToolResultOnly()) {
      out[out.length - 1]!.content.push({ type: 'tool_result', tool_use_id: toolUseId, content });
    } else {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] });
    }
  };

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === 'user') {
      pushUserText(m.content ?? '');
    } else if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
      out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      pushToolResult(m.toolCallId ?? '', m.content ?? '');
    }
  }

  const payload: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens,
    messages: out,
    temperature: config.temperature,
  };
  if (systemParts.length) payload.system = systemParts.join('\n\n');
  if (tools.length) {
    payload.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    payload.tool_choice = { type: 'auto' };
  }
  return payload;
}

interface AnthropicRawContent { type?: string; text?: string; id?: string; name?: string; input?: unknown; }
interface AnthropicRawResponse {
  stop_reason?: string;
  content?: AnthropicRawContent[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Parse an Anthropic Messages response into a normalised ModelResponse. */
export function parseAnthropicResponse(data: unknown): ModelResponse {
  const raw = data as AnthropicRawResponse;
  const blocks: AnthropicRawContent[] = raw.content ?? [];
  const textParts: string[] = [];
  const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text != null) textParts.push(b.text);
    if (b.type === 'tool_use' && b.id && b.name) {
      toolCalls.push({
        id: b.id,
        name: b.name,
        arguments:
          b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {},
      });
    }
  }
  const input = raw.usage?.input_tokens ?? 0;
  const output = raw.usage?.output_tokens ?? 0;
  const usage: TokenUsage = {
    prompt: raw.usage?.input_tokens,
    completion: raw.usage?.output_tokens,
    total: input + output || undefined,
  };
  return {
    text: textParts.length ? textParts.join('\n') : null,
    toolCalls,
    usage,
    stopReason: raw.stop_reason,
    raw,
  };
}

/** Anthropic Messages API adapter with tool use. */
export class AnthropicAdapter extends BaseAdapter {
  protected baseUrl: string;
  protected apiKey: string | null;

  constructor(config: ModelConfig, logger?: Logger) {
    super(config, logger);
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
    this.apiKey = config.apiKeyEnv
      ? process.env[config.apiKeyEnv] ?? null
      : process.env.ANTHROPIC_API_KEY ?? null;
  }

  async sendMessage(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelResponse> {
    return this.withRetry(async () => {
      const url = this.baseUrl.replace(/\/+$/, '') + '/v1/messages';
      const body = buildAnthropicPayload(messages, tools, this.config);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (this.apiKey) headers['x-api-key'] = this.apiKey;

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
      return parseAnthropicResponse(data);
    });
  }
}
