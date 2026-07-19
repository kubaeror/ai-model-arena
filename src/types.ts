// Shared types for ai-model-arena.
// All cross-module interfaces live here so adapters, the agent loop, the
// sandbox, tools, and the logger speak the same language.

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A single tool invocation requested by the model. */
export interface ToolCall {
  /** Provider-assigned id used to correlate tool results with requests. */
  id: string;
  name: string;
  /** Parsed JSON arguments (always an object). */
  arguments: Record<string, unknown>;
}

/** A chat message in the provider-agnostic conversation format. */
export interface ChatMessage {
  role: Role;
  content: string | null;
  /** Optional name for tool messages (OpenAI allows it). */
  name?: string;
  /** Assistant-requested tool calls. */
  toolCalls?: ToolCall[];
  /** For role === 'tool': the id of the tool call this result answers. */
  toolCallId?: string;
}

export interface TokenUsage {
  prompt?: number;
  completion?: number;
  total?: number;
}

/** Normalised response from any model adapter. */
export interface ModelResponse {
  text: string | null;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  stopReason?: string;
  /** Raw provider payload, kept for debugging/logging. */
  raw?: unknown;
}

/** Tool definition with a JSON-Schema `parameters` object. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

/** Minimal structured logger interface (pino-backed implementation in logger/). */
export interface Logger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
  child(name: string): Logger;
}

/** Context handed to every tool executor; scopes execution to a sandbox. */
export interface ToolExecutionContext {
  sandboxDir: string;
  logger: Logger;
  shellTimeoutMs: number;
  maxShellOutputBytes: number;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => Promise<{ content: string; isError: boolean }>;

export interface ToolExecutorMap {
  [name: string]: ToolExecutor;
}
