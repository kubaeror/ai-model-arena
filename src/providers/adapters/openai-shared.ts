import type { ChatMessage, ModelResponse, TokenUsage, ToolCall, ToolDefinition } from '../../types.js';
import type { SendOpts } from './base.js';

/**
 * Shared OpenAI-compatible chat-completion plumbing, extracted from
 * openai-compat.ts and reused by bedrock.ts's gateway path (the gateway IS an
 * OpenAI-compatible client, so the wire format and parsing must be identical).
 */

interface OpenAIChoice {
  message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
  finish_reason: string;
}

export interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export function buildOpenAIBody(
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  opts?: SendOpts,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
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
  if (opts?.reasoning?.type === 'effort') body.reasoning_effort = String(opts.reasoning.value ?? 'medium');
  return body;
}

export function parseOpenAIResponse(json: OpenAIResponse): ModelResponse {
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
