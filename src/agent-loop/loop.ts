import type {
  ChatMessage,
  ToolDefinition,
  Logger,
  ToolExecutionContext,
  ToolExecutorMap,
  TokenUsage,
} from '../types.js';
import type { ModelAdapter, SendOpts } from '../providers/adapters/base.js';
import type { ConversationLogger } from '../logger/conversation-logger.js';
import { TASK_COMPLETE_TOOL } from '../tools/schema.js';
import { detectInjection, scanToolResult } from '../security/prompt-injection.js';
import { startAgentSpan, startToolSpan, endSpan, setSpanAttributes } from '../observability/instrumentation-helpers.js';

export interface AgentLoopOptions {
  adapter: ModelAdapter;
  tools: ToolDefinition[];
  executors: ToolExecutorMap;
  systemPrompt: string;
  task: string;
  maxTurns: number;
  toolCtx: ToolExecutionContext;
  conv: ConversationLogger;
  logger: Logger;
  /** Pre-existing messages to replay (checkpoint resume). Skips system+task injection. */
  initialMessages?: ChatMessage[];
  /** Called after each turn with ONLY the messages appended this turn. */
  onTurnComplete?: (turn: number, newMessages: ChatMessage[], tokenUsage: TokenUsage, durationMs?: number) => Promise<void>;
  /** If provided, called after each turn to check budget. Return false to abort the run. */
  onBudgetCheck?: (turn: number, tokenUsage: TokenUsage) => Promise<boolean>;
  /** Model-send options forwarded to every adapter.sendMessage call (e.g. reasoning). */
  sendOpts?: SendOpts;
}

export interface AgentLoopResult {
  turnsUsed: number;
  maxTurns: number;
  totalToolCalls: number;
  toolsCalled: { name: string; count: number }[];
  /** Per-tool success/fail breakdown. Keyed by tool name, values are {success, fail} counts. */
  toolSuccessRates: Record<string, { success: number; fail: number }>;
  tokenUsage: TokenUsage;
  stopReason: string;
  errors: string[];
}

const MAX_TOOL_RESULT_CHARS = 60_000;
/** Upper bound on the in-context message window; oldest turns get compacted. */
const MAX_CONTEXT_CHARS = 150_000;
/** Turns kept at the tail when compaction kicks in (current + recent). */
const KEEP_TAIL_TURNS = 4;

function truncate(s: string, max = MAX_TOOL_RESULT_CHARS): string {
  return s.length <= max ? s : s.slice(0, max) + '\n…[tool result truncated]';
}

/**
 * Drop the oldest tool/assistant messages once the window exceeds
 * MAX_CONTEXT_CHARS, keeping the system prompt, the initial task, and the
 * most recent KEEP_TAIL_TURNS turns. Tool results dominate the size, so
 * dropping the oldest of them keeps the model's context window bounded on
 * long runs.
 */
/** Exported for tests. */
export function compactMessages(messages: ChatMessage[], protectedTail: number): void {
  let total = messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0);
  if (total <= MAX_CONTEXT_CHARS || messages.length <= 2) return;

  const keepHead = Math.min(2, messages.length - protectedTail);
  const droppableStart = keepHead;
  const droppableEnd = Math.max(keepHead, messages.length - protectedTail);

  while (droppableEnd > droppableStart && total > MAX_CONTEXT_CHARS) {
    let droppedChars = 0;
    let dropped = 0;
    for (let i = droppableStart; i < droppableEnd; i++) {
      droppedChars += messages[i]?.content?.length ?? 0;
      dropped++;
      if (total - droppedChars <= MAX_CONTEXT_CHARS) break;
    }
    messages.splice(droppableStart, dropped);
    total -= droppedChars;
  }
}

/**
 * Core agentic loop: send prompt -> receive output -> if tool_calls present,
 * execute them, append results to the conversation, loop again. Stops on
 * max_turns, on a `task_complete` tool call, or when the model replies with no
 * tool calls. Every step is mirrored into the ConversationLogger for durability.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const { adapter, tools, executors, systemPrompt, task, maxTurns, toolCtx, conv, logger, onTurnComplete, onBudgetCheck, sendOpts } = opts;

  const loopSpan = startAgentSpan('agent-loop', {
    max_turns: maxTurns,
    tool_count: tools.length,
  });

  const messages: ChatMessage[] = opts.initialMessages && opts.initialMessages.length > 0
    ? [...opts.initialMessages]
    : [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task },
    ];

  // Scan initial messages for prompt injection patterns
  for (const msg of messages) {
    const scan = detectInjection({ content: msg.content ?? undefined });
    if (scan.flagged) {
      logger.warn('Prompt injection detected in initial message', {
        role: msg.role,
        reasons: scan.reasons,
      });
      conv.append({
        type: 'info',
        content: `⚠ Prompt injection flagged in ${msg.role} message: ${scan.reasons?.join(', ')}`,
      });
    }
  }

  if (opts.initialMessages && opts.initialMessages.length > 0) {
    conv.append({ type: 'system', role: 'system', content: '[resumed from checkpoint]' });
  } else {
    conv.append({ type: 'system', role: 'system', content: systemPrompt });
    conv.append({ type: 'user', role: 'user', content: task });
  }

  const usage: TokenUsage = {};
  const toolCounts = new Map<string, number>();
  const toolSuccessRates: Record<string, { success: number; fail: number }> = {};
  const errors: string[] = [];
  let totalToolCalls = 0;
  let stopReason = 'unknown';
  let turnsUsed = 0;

  if (maxTurns < 1) {
    stopReason = 'max_turns';
    logger.warn('Agent stopped: max_turns reached', { turnsUsed: 0, maxTurns });
    setSpanAttributes(loopSpan, {
      stop_reason: stopReason,
      turns_used: 0,
      total_tool_calls: totalToolCalls,
      'gen_ai.usage.input_tokens': usage.prompt ?? 0,
      'gen_ai.usage.output_tokens': usage.completion ?? 0,
      'gen_ai.usage.total_tokens': usage.total ?? 0,
    });
    endSpan(loopSpan);
    conv.flush();
    return { turnsUsed: 0, maxTurns, totalToolCalls: 0, toolsCalled: [], toolSuccessRates: {}, tokenUsage: usage, stopReason, errors: [] };
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (onBudgetCheck) {
      try {
        const ok = await onBudgetCheck(turn, usage);
        if (!ok) {
          stopReason = 'budget_exceeded';
          logger.warn('Agent stopped: budget exceeded', { turn, tokens: usage.total });
          break;
        }
      } catch (e) { logger.warn('onBudgetCheck failed', { turn, err: String(e) }); }
    }
    turnsUsed = turn;
    logger.info('Agent turn', { turn, maxTurns });

    // Snapshot length so onTurnComplete only receives this turn's messages.
    const turnStartIndex = messages.length;

    let response;
    let responseDurationMs: number | undefined;
    try {
      response = await adapter.sendMessage(messages, tools, sendOpts);
      responseDurationMs = response.durationMs;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Model API call failed', { turn, error: msg });
      setSpanAttributes(loopSpan, {
        stop_reason: 'api_error',
        turns_used: turn,
        error: msg,
      });
      endSpan(loopSpan, err instanceof Error ? err : new Error(msg));
      errors.push(`Turn ${turn}: model API error: ${msg}`);
      conv.append({ type: 'error', turn, content: `Model API error: ${msg}` });
      stopReason = 'api_error';
      break;
    }

    messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });
    conv.append({
      type: 'assistant',
      turn,
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
      usage: response.usage,
      stopReason: response.stopReason,
    });

    if (response.usage) {
      usage.prompt = (usage.prompt ?? 0) + (response.usage.prompt ?? 0);
      usage.completion = (usage.completion ?? 0) + (response.usage.completion ?? 0);
      usage.total = (usage.total ?? 0) + (response.usage.total ?? 0);
    }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      stopReason = 'no_tool_calls';
      logger.info('Agent finished (no tool calls)', { turn });
      break;
    }

    const wantsComplete = response.toolCalls.some((tc) => tc.name === TASK_COMPLETE_TOOL);

    for (const tc of response.toolCalls) {
      totalToolCalls++;
      toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1);
      conv.append({ type: 'tool_call', turn, toolCallId: tc.id, toolName: tc.name, meta: { args: tc.arguments } });

      const executor = executors[tc.name];
      let content: string;
      let isError = false;
      if (!executor) {
        content = `Error: unknown tool "${tc.name}". Available: ${tools.map((t) => t.name).join(', ')}`;
        isError = true;
        errors.push(`Turn ${turn}: unknown tool "${tc.name}"`);
      } else {
        try {
          const toolSpan = startToolSpan(tc.name);
          const res = await executor(tc.arguments, toolCtx);
          endSpan(toolSpan);
          content = res.content;
          isError = res.isError;
          if (isError) errors.push(`Turn ${turn}: tool "${tc.name}" reported an error`);
        } catch (err) {
          const toolSpan = startToolSpan(tc.name);
          endSpan(toolSpan, err instanceof Error ? err : new Error(String(err)));
          content = `Error executing "${tc.name}": ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
          errors.push(`Turn ${turn}: tool "${tc.name}" threw: ${content}`);
        }
      }

      content = truncate(content);
      conv.append({ type: 'tool_result', turn, toolCallId: tc.id, toolName: tc.name, toolResult: content, isError });
      messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content });

      // Track per-tool success/fail rates
      const rate = toolSuccessRates[tc.name] ?? { success: 0, fail: 0 };
      if (isError) rate.fail++;
      else rate.success++;
      toolSuccessRates[tc.name] = rate;

      // Scan tool output for indirect prompt injection patterns
      const scan = scanToolResult(content);
      if (scan.flagged) {
        logger.warn('Tool output flagged for injection patterns', {
          toolName: tc.name,
          turn,
          reasons: scan.reasons,
        });
        conv.append({
          type: 'info',
          content: `⚠ Tool output from "${tc.name}" flagged for injection patterns: ${scan.reasons?.join(', ')}`,
        });
      }
    }

    // Snapshot this turn's messages BEFORE compaction (it splices from the
    // front and would shift the index slice).
    const turnMessages = messages.slice(turnStartIndex);

    // Bound the context window so long runs don't overflow the model's limit.
    const prevLen = messages.length;
    compactMessages(messages, KEEP_TAIL_TURNS);
    if (messages.length < prevLen) {
      logger.warn('Context window compacted', { turn, dropped: prevLen - messages.length });
      conv.append({ type: 'info', turn, content: `⚠ Context window compacted: oldest ${prevLen - messages.length} messages dropped to stay under ${MAX_CONTEXT_CHARS} chars.` });
    }

    // Persist this turn BEFORE the completion break so the final assistant
    // message survives a crash — checkpoint/resume depends on it.
    if (onTurnComplete) {
      try { await onTurnComplete(turn, turnMessages, usage, responseDurationMs); } catch (e) { logger.warn('onTurnComplete failed', { turn, err: String(e) }); }
    }

    if (wantsComplete) {
      stopReason = 'task_complete';
      logger.info('Agent signalled task_complete', { turn });
      break;
    }
  }

  if (turnsUsed >= maxTurns && stopReason === 'unknown') {
    stopReason = 'max_turns';
    logger.warn('Agent stopped: max_turns reached', { turnsUsed, maxTurns });
  }

  setSpanAttributes(loopSpan, {
    stop_reason: stopReason,
    turns_used: turnsUsed,
    total_tool_calls: totalToolCalls,
    'gen_ai.usage.input_tokens': usage.prompt ?? 0,
    'gen_ai.usage.output_tokens': usage.completion ?? 0,
    'gen_ai.usage.total_tokens': usage.total ?? 0,
  });
  endSpan(loopSpan);

  const toolsCalled = [...toolCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  conv.flush();
  return { turnsUsed, maxTurns, totalToolCalls, toolsCalled, toolSuccessRates, tokenUsage: usage, stopReason, errors };
}
