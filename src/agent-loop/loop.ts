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
import type { Span } from '@opentelemetry/api';
import { runTurnLoop } from './turn-loop.js';

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
  /** First turn number for this execution (checkpoint resume continuation). Defaults to 1. */
  initialTurn?: number;
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

/** Upper bound on the in-context message window; oldest turns get compacted. */
const MAX_CONTEXT_CHARS = 150_000;
/** Turns kept at the tail when compaction kicks in (current + recent). */
const KEEP_TAIL_TURNS = 4;

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
 * The send->tool->loop skeleton is shared with the subagent loop via
 * runTurnLoop (src/agent-loop/turn-loop.ts); this function keeps the
 * caller-specific concerns: system prompt, injection scan, context compaction,
 * budget checks, onTurnComplete persistence, transcripts, and spans.
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

  // Only the maxTurns<1 early return below uses this; the shared loop
  // accumulates usage for every other path.
  const usage: TokenUsage = {};

  if (maxTurns < 1) {
    const stopReason = 'max_turns';
    logger.warn('Agent stopped: max_turns reached', { turnsUsed: 0, maxTurns });
    setSpanAttributes(loopSpan, {
      stop_reason: stopReason,
      turns_used: 0,
      total_tool_calls: 0,
      'gen_ai.usage.input_tokens': usage.prompt ?? 0,
      'gen_ai.usage.output_tokens': usage.completion ?? 0,
      'gen_ai.usage.total_tokens': usage.total ?? 0,
    });
    endSpan(loopSpan);
    conv.flush();
    return { turnsUsed: 0, maxTurns, totalToolCalls: 0, toolsCalled: [], toolSuccessRates: {}, tokenUsage: usage, stopReason, errors: [] };
  }

  // Tracks the in-flight tool span so onToolEnd closes the exact span that
  // onToolStart opened (mirrors the historical per-call span pairing).
  let activeToolSpan: Span | undefined;

  const result = await runTurnLoop({
    adapter,
    tools,
    executors,
    toolCtx,
    logger,
    messages,
    maxTurns,
    startTurn: opts.initialTurn ?? 1,
    taskCompleteToolName: TASK_COMPLETE_TOOL,
    sendOpts,
    hooks: {
      onTurnStart: async (turn, usage) => {
        if (onBudgetCheck) {
          try {
            const ok = await onBudgetCheck(turn, usage);
            if (!ok) {
              logger.warn('Agent stopped: budget exceeded', { turn, tokens: usage.total });
              return false;
            }
          } catch (e) { logger.warn('onBudgetCheck failed', { turn, err: String(e) }); }
        }
        logger.info('Agent turn', { turn, maxTurns });
        return true;
      },
      onTurn: async (turn, turnMessages, usage, messages, durationMs) => {
        // Bound the context window so long runs don't overflow the model's limit.
        const prevLen = messages.length;
        compactMessages(messages, KEEP_TAIL_TURNS);
        if (messages.length < prevLen) {
          logger.warn('Context window compacted', { turn, dropped: prevLen - messages.length });
          conv.append({ type: 'info', turn, content: `⚠ Context window compacted: oldest ${prevLen - messages.length} messages dropped to stay under ${MAX_CONTEXT_CHARS} chars.` });
        }

        // Persist this turn BEFORE either completion break so the final assistant
        // message survives a crash — checkpoint/resume depends on it. Fires once
        // per completed model turn; not for api_error, where the send failed.
        if (onTurnComplete) {
          try { await onTurnComplete(turn, turnMessages, usage, durationMs); } catch (e) { logger.warn('onTurnComplete failed', { turn, err: String(e) }); }
        }
        return true;
      },
    },
    events: {
      onAssistantMessage: (turn, text, toolCalls, usage, stopReason) => {
        conv.append({
          type: 'assistant',
          turn,
          role: 'assistant',
          content: text,
          toolCalls,
          usage,
          stopReason,
        });
      },
      onToolCall: (turn, toolCallId, toolName, args) => {
        conv.append({ type: 'tool_call', turn, toolCallId, toolName, meta: { args } });
      },
      onToolStart: (toolName) => {
        activeToolSpan = startToolSpan(toolName);
      },
      onToolEnd: (toolName, error) => {
        if (error) {
          // Historical quirk: the in-flight span is abandoned and a fresh one
          // records the failure.
          endSpan(startToolSpan(toolName), error instanceof Error ? error : new Error(String(error)));
        } else if (activeToolSpan) {
          endSpan(activeToolSpan);
        }
        activeToolSpan = undefined;
      },
      onToolResult: (turn, toolCallId, toolName, content, isError) => {
        conv.append({ type: 'tool_result', turn, toolCallId, toolName, toolResult: content, isError });

        // Scan tool output for indirect prompt injection patterns
        const scan = scanToolResult(content);
        if (scan.flagged) {
          logger.warn('Tool output flagged for injection patterns', {
            toolName,
            turn,
            reasons: scan.reasons,
          });
          conv.append({
            type: 'info',
            content: `⚠ Tool output from "${toolName}" flagged for injection patterns: ${scan.reasons?.join(', ')}`,
          });
        }
      },
      onApiError: (turn, message, error) => {
        logger.error('Model API call failed', { turn, error: message });
        setSpanAttributes(loopSpan, {
          stop_reason: 'api_error',
          turns_used: turn,
          error: message,
        });
        endSpan(loopSpan, error instanceof Error ? error : new Error(message));
        conv.append({ type: 'error', turn, content: `Model API error: ${message}` });
      },
      onNoToolCalls: (turn) => {
        logger.info('Agent finished (no tool calls)', { turn });
      },
      onTaskComplete: (turn) => {
        logger.info('Agent signalled task_complete', { turn });
      },
    },
  });

  const stopReason = result.turnsUsed >= maxTurns && result.stopReason === 'unknown' ? 'max_turns' : result.stopReason;
  if (stopReason === 'max_turns') {
    logger.warn('Agent stopped: max_turns reached', { turnsUsed: result.turnsUsed, maxTurns });
  }

  setSpanAttributes(loopSpan, {
    stop_reason: stopReason,
    turns_used: result.turnsUsed,
    total_tool_calls: result.totalToolCalls,
    'gen_ai.usage.input_tokens': result.tokenUsage.prompt ?? 0,
    'gen_ai.usage.output_tokens': result.tokenUsage.completion ?? 0,
    'gen_ai.usage.total_tokens': result.tokenUsage.total ?? 0,
  });
  endSpan(loopSpan);

  conv.flush();
  return {
    turnsUsed: result.turnsUsed,
    maxTurns,
    totalToolCalls: result.totalToolCalls,
    toolsCalled: result.toolsCalled,
    toolSuccessRates: result.toolSuccessRates,
    tokenUsage: result.tokenUsage,
    stopReason,
    errors: result.errors,
  };
}
