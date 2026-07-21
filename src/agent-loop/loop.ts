import type {
  ChatMessage,
  ToolDefinition,
  Logger,
  ToolExecutionContext,
  ToolExecutorMap,
  TokenUsage,
} from '../types.js';
import type { ModelAdapter } from '../providers/adapters/base.js';
import type { ConversationLogger } from '../logger/conversation-logger.js';
import { TASK_COMPLETE_TOOL } from '../tools/schema.js';
import { detectInjection } from '../security/prompt-injection.js';

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
  onTurnComplete?: (turn: number, messages: ChatMessage[]) => Promise<void>;
  /** If provided, called after each turn to check budget. Return false to abort the run. */
  onBudgetCheck?: (turn: number, tokenUsage: TokenUsage) => Promise<boolean>;
}

export interface AgentLoopResult {
  turnsUsed: number;
  maxTurns: number;
  totalToolCalls: number;
  toolsCalled: { name: string; count: number }[];
  tokenUsage: TokenUsage;
  stopReason: string;
  errors: string[];
}

const MAX_TOOL_RESULT_CHARS = 60_000;

function truncate(s: string, max = MAX_TOOL_RESULT_CHARS): string {
  return s.length <= max ? s : s.slice(0, max) + '\n…[tool result truncated]';
}

/**
 * Core agentic loop: send prompt -> receive output -> if tool_calls present,
 * execute them, append results to the conversation, loop again. Stops on
 * max_turns, on a `task_complete` tool call, or when the model replies with no
 * tool calls. Every step is mirrored into the ConversationLogger for durability.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const { adapter, tools, executors, systemPrompt, task, maxTurns, toolCtx, conv, logger, onTurnComplete, onBudgetCheck } = opts;

  const messages: ChatMessage[] = [
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

  conv.append({ type: 'system', role: 'system', content: systemPrompt });
  conv.append({ type: 'user', role: 'user', content: task });

  const usage: TokenUsage = {};
  const toolCounts = new Map<string, number>();
  const errors: string[] = [];
  let totalToolCalls = 0;
  let stopReason = 'unknown';
  let turnsUsed = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    turnsUsed = turn;
    logger.info('Agent turn', { turn, maxTurns });

    let response;
    try {
      response = await adapter.sendMessage(messages, tools);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Model API call failed', { turn, error: msg });
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
          const res = await executor(tc.arguments, toolCtx);
          content = res.content;
          isError = res.isError;
          if (isError) errors.push(`Turn ${turn}: tool "${tc.name}" reported an error`);
        } catch (err) {
          content = `Error executing "${tc.name}": ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
          errors.push(`Turn ${turn}: tool "${tc.name}" threw: ${content}`);
        }
      }

      content = truncate(content);
      conv.append({ type: 'tool_result', turn, toolCallId: tc.id, toolName: tc.name, toolResult: content, isError });
      messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content });
    }

    if (wantsComplete) {
      stopReason = 'task_complete';
      logger.info('Agent signalled task_complete', { turn });
      break;
    }

    if (onTurnComplete) {
      try { await onTurnComplete(turn, messages); } catch (e) { logger.warn('onTurnComplete failed', { turn, err: String(e) }); }
    }

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
  }

  if (turnsUsed >= maxTurns && stopReason === 'unknown') {
    stopReason = 'max_turns';
    logger.warn('Agent stopped: max_turns reached', { turnsUsed, maxTurns });
  }

  const toolsCalled = [...toolCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  conv.flush();
  return { turnsUsed, maxTurns, totalToolCalls, toolsCalled, tokenUsage: usage, stopReason, errors };
}
