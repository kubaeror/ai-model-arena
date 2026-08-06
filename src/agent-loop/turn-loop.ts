import type {
  ChatMessage,
  ToolDefinition,
  Logger,
  ToolExecutionContext,
  ToolExecutorMap,
  TokenUsage,
  ToolCall,
  ModelResponse,
} from '../types.js';
import type { ModelAdapter, SendOpts } from '../providers/adapters/base.js';

/**
 * Per-caller error-text formatters. Defaults match the agent loop's historical
 * wording; the subagent overrides them with its own phrasing.
 */
export interface TurnLoopErrorFormatters {
  apiError: (turn: number, message: string) => string;
  unknownTool: (turn: number, name: string) => string;
  toolError: (turn: number, name: string, content: string) => string;
  toolThrew: (turn: number, name: string, content: string) => string;
}

/** Per-turn hooks. Returning false aborts the loop. */
export interface TurnLoopHooks {
  /** Called before each model send; return false to abort the loop ('budget_exceeded'). */
  onTurnStart?: (turn: number, usage: TokenUsage) => Promise<boolean>;
  /**
   * Called after each completed turn, before the stop-reason breaks. `newMessages`
   * is the slice appended this turn (snapshotted before any caller-side compaction
   * of `messages`), and `durationMs` is the model request latency when known.
   * Return false to abort; a stop reason the turn already decided (e.g.
   * 'no_tool_calls') takes precedence over the abort.
   */
  onTurn?: (
    turn: number,
    newMessages: ChatMessage[],
    usage: TokenUsage,
    messages: ChatMessage[],
    durationMs?: number,
  ) => Promise<boolean>;
}

/**
 * Synchronous observation points the loop emits so callers can attach their own
 * side effects (spans, transcripts, injection scanning) without the primitive
 * knowing about them.
 */
export interface TurnLoopEvents {
  /** After the assistant message is appended to `messages`. */
  onAssistantMessage?: (
    turn: number,
    text: string | null,
    toolCalls: ToolCall[] | undefined,
    usage: TokenUsage | undefined,
    stopReason: string | undefined,
  ) => void;
  /** Before a tool executor runs. */
  onToolCall?: (turn: number, toolCallId: string, toolName: string, args: Record<string, unknown>) => void;
  /** Right before the executor call. */
  onToolStart?: (toolName: string) => void;
  /** Right after the executor call; `error` is set when the executor threw. */
  onToolEnd?: (toolName: string, error?: unknown) => void;
  /** After the tool result is truncated, before it is appended to `messages`. */
  onToolResult?: (turn: number, toolCallId: string, toolName: string, content: string, isError: boolean) => void;
  /** When a model send fails. */
  onApiError?: (turn: number, message: string, error: unknown) => void;
  /** When the model replies with no tool calls (stopReason 'no_tool_calls' decided). */
  onNoToolCalls?: (turn: number) => void;
  /** When a task_complete tool call stops the loop. */
  onTaskComplete?: (turn: number) => void;
}

export interface TurnLoopOptions {
  adapter: ModelAdapter;
  tools: ToolDefinition[];
  executors: ToolExecutorMap;
  toolCtx: ToolExecutionContext;
  logger: Logger;
  /** Owned by the caller; the loop appends assistant + tool messages to it. */
  messages: ChatMessage[];
  maxTurns: number;
  /** Tool name that signals task completion (e.g. 'task_complete'); undefined disables detection. */
  taskCompleteToolName?: string;
  /** Model-send options forwarded to every adapter.sendMessage call. */
  sendOpts?: SendOpts;
  /** First turn number; defaults to 1. */
  startTurn?: number;
  /** Tool-result truncation cap in chars; defaults to 60_000. */
  maxToolResultChars?: number;
  /** Truncation suffix; defaults to the agent loop's '\n…[tool result truncated]'. */
  truncateSuffix?: string;
  /** Content for unknown-tool results; defaults to the agent loop's "Available: ..." message. */
  unknownToolContent?: (name: string, tools: ToolDefinition[]) => string;
  /** Error-text formatters; defaults to the agent loop's wording. */
  errorFormatters?: Partial<TurnLoopErrorFormatters>;
  hooks?: TurnLoopHooks;
  events?: TurnLoopEvents;
}

export interface TurnLoopResult {
  turnsUsed: number;
  totalToolCalls: number;
  toolsCalled: { name: string; count: number }[];
  toolSuccessRates: Record<string, { success: number; fail: number }>;
  tokenUsage: TokenUsage;
  /** 'unknown' when the loop exhausted maxTurns — callers map that to 'max_turns'. */
  stopReason: string;
  errors: string[];
}

const DEFAULT_MAX_TOOL_RESULT_CHARS = 60_000;
const DEFAULT_TRUNCATE_SUFFIX = '\n…[tool result truncated]';
const DEFAULT_FORMATTERS: TurnLoopErrorFormatters = {
  apiError: (turn, message) => `Turn ${turn}: model API error: ${message}`,
  unknownTool: (turn, name) => `Turn ${turn}: unknown tool "${name}"`,
  toolError: (turn, name) => `Turn ${turn}: tool "${name}" reported an error`,
  toolThrew: (turn, name, content) => `Turn ${turn}: tool "${name}" threw: ${content}`,
};
const DEFAULT_UNKNOWN_TOOL_CONTENT = (name: string, tools: ToolDefinition[]): string =>
  `Error: unknown tool "${name}". Available: ${tools.map((t) => t.name).join(', ')}`;

/**
 * Shared send -> tool-call -> execute -> append turn loop. This is the mechanical
 * skeleton behind both the agent loop and the subagent loop: it owns the turn
 * iteration, model sends, tool execution, result accumulation, and stop conditions,
 * and delegates everything caller-specific (budget checks, compaction, transcripts,
 * spans, error wording, truncation caps) to hooks/events/options.
 */
export async function runTurnLoop(opts: TurnLoopOptions): Promise<TurnLoopResult> {
  const { adapter, tools, executors, toolCtx, messages, maxTurns, taskCompleteToolName, sendOpts } = opts;
  const startTurn = opts.startTurn ?? 1;
  const maxToolResultChars = opts.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  const truncateSuffix = opts.truncateSuffix ?? DEFAULT_TRUNCATE_SUFFIX;
  const unknownToolContent = opts.unknownToolContent ?? DEFAULT_UNKNOWN_TOOL_CONTENT;
  const formatters: TurnLoopErrorFormatters = { ...DEFAULT_FORMATTERS, ...opts.errorFormatters };
  const hooks: TurnLoopHooks = opts.hooks ?? {};
  const events: TurnLoopEvents = opts.events ?? {};

  const usage: TokenUsage = {};
  const toolCounts = new Map<string, number>();
  const toolSuccessRates: Record<string, { success: number; fail: number }> = {};
  const errors: string[] = [];
  let totalToolCalls = 0;
  let stopReason = 'unknown';
  let turnsUsed = 0;

  for (let turn = startTurn; turn <= maxTurns; turn++) {
    if (hooks.onTurnStart) {
      const ok = await hooks.onTurnStart(turn, usage);
      if (!ok) {
        stopReason = 'budget_exceeded';
        break;
      }
    }
    turnsUsed = turn;

    // Snapshot length so the onTurn hook only receives this turn's messages.
    const turnStartIndex = messages.length;

    let response: ModelResponse;
    let responseDurationMs: number | undefined;
    try {
      response = await adapter.sendMessage(messages, tools, sendOpts);
      responseDurationMs = response.durationMs;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(formatters.apiError(turn, msg));
      events.onApiError?.(turn, msg, err);
      stopReason = 'api_error';
      break;
    }

    messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });
    events.onAssistantMessage?.(turn, response.text, response.toolCalls, response.usage, response.stopReason);

    if (response.usage) {
      usage.prompt = (usage.prompt ?? 0) + (response.usage.prompt ?? 0);
      usage.completion = (usage.completion ?? 0) + (response.usage.completion ?? 0);
      usage.total = (usage.total ?? 0) + (response.usage.total ?? 0);
    }

    const wantsComplete = taskCompleteToolName != null
      ? (response.toolCalls ? response.toolCalls.some((tc) => tc.name === taskCompleteToolName) : false)
      : false;

    if (!response.toolCalls || response.toolCalls.length === 0) {
      stopReason = 'no_tool_calls';
      events.onNoToolCalls?.(turn);
    } else {
      for (const tc of response.toolCalls) {
        totalToolCalls++;
        toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1);
        events.onToolCall?.(turn, tc.id, tc.name, tc.arguments);

        const executor = executors[tc.name];
        let content: string;
        let isError = false;
        if (!executor) {
          content = unknownToolContent(tc.name, tools);
          isError = true;
          errors.push(formatters.unknownTool(turn, tc.name));
        } else {
          try {
            events.onToolStart?.(tc.name);
            const res = await executor(tc.arguments, toolCtx);
            events.onToolEnd?.(tc.name);
            content = res.content;
            isError = res.isError;
            if (isError) errors.push(formatters.toolError(turn, tc.name, content));
          } catch (err) {
            events.onToolEnd?.(tc.name, err);
            content = `Error executing "${tc.name}": ${err instanceof Error ? err.message : String(err)}`;
            isError = true;
            errors.push(formatters.toolThrew(turn, tc.name, content));
          }
        }

        content = content.length <= maxToolResultChars ? content : content.slice(0, maxToolResultChars) + truncateSuffix;
        events.onToolResult?.(turn, tc.id, tc.name, content, isError);
        messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content });

        // Track per-tool success/fail rates
        const rate = toolSuccessRates[tc.name] ?? { success: 0, fail: 0 };
        if (isError) rate.fail++;
        else rate.success++;
        toolSuccessRates[tc.name] = rate;
      }
    }

    // Snapshot this turn's messages BEFORE the onTurn hook, which may compact
    // `messages` from the front (that would shift the slice).
    const turnMessages = messages.slice(turnStartIndex);

    if (hooks.onTurn) {
      const keepGoing = await hooks.onTurn(turn, turnMessages, usage, messages, responseDurationMs);
      if (!keepGoing) {
        if (stopReason === 'unknown') stopReason = 'budget_exceeded';
        break;
      }
    }

    if (stopReason === 'no_tool_calls') {
      break;
    }

    if (wantsComplete) {
      stopReason = 'task_complete';
      events.onTaskComplete?.(turn);
      break;
    }
  }

  const toolsCalled = [...toolCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  return { turnsUsed, totalToolCalls, toolsCalled, toolSuccessRates, tokenUsage: usage, stopReason, errors };
}
