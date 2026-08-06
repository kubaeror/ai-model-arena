import { z } from 'zod/v4';
import { validateArgs } from './util.js';
import type { ToolExecutor, ChatMessage, TokenUsage, SubagentConfig } from '../types.js';
import type { ModelAdapter } from '../providers/adapters/base.js';
import { runTurnLoop } from '../agent-loop/turn-loop.js';
import { TASK_COMPLETE_TOOL } from './schema.js';

const TaskArgs = z.object({
  description: z.string().min(1).max(100),
  prompt: z.string().min(1),
  subagent_name: z.string().optional(),
}).strict();

const MAX_SUBAGENT_TOOL_RESULT_CHARS = 30_000;
const SUBAGENT_TRUNCATE_SUFFIX = '\n…[truncated]';

/**
 * Subagent loop. Delegates the send->tool->loop skeleton to runTurnLoop
 * (src/agent-loop/turn-loop.ts) — the shared primitive that the agent loop
 * uses too. The adapter stays a function on the SubagentConfig so the tool
 * layer never imports the agent-loop module's dependencies, keeping the
 * dependency graph acyclic.
 */
async function runSubagent(
  sub: SubagentConfig,
  sandboxDir: string,
  taskPrompt: string,
): Promise<{
  turnsUsed: number;
  totalToolCalls: number;
  tokenUsage: TokenUsage;
  stopReason: string;
  finalOutput: string;
  errors: string[];
}> {
  const messages: ChatMessage[] = [
    { role: 'system', content: `You are a subagent of the AI Model Arena. Your task: ${taskPrompt}\nWork autonomously. Call task_complete when done.` },
    { role: 'user', content: taskPrompt },
  ];

  // Minimal ModelAdapter shim over the function-style subagent adapter.
  const adapter: ModelAdapter = {
    sendMessage: (msgs, tools) => sub.sendMessage(msgs, tools),
    supportsReasoning: () => false,
    supportsPromptCaching: () => false,
  };

  const result = await runTurnLoop({
    adapter,
    tools: sub.tools,
    executors: sub.executors,
    toolCtx: {
      sandboxDir,
      logger: sub.logger,
      shellTimeoutMs: sub.shellTimeoutMs,
      maxShellOutputBytes: sub.maxShellOutputBytes,
      shellPolicy: sub.shellPolicy,
      webAccess: sub.webAccess,
      executionProfile: sub.executionProfile,
      allowedTools: sub.allowedTools,
    },
    logger: sub.logger,
    messages,
    maxTurns: sub.maxTurns,
    taskCompleteToolName: TASK_COMPLETE_TOOL,
    maxToolResultChars: MAX_SUBAGENT_TOOL_RESULT_CHARS,
    truncateSuffix: SUBAGENT_TRUNCATE_SUFFIX,
    unknownToolContent: (name) => `Error: unknown tool "${name}"`,
    errorFormatters: {
      apiError: (turn, message) => `Subagent turn ${turn}: ${message}`,
      unknownTool: (_turn, name) => `Subagent: unknown tool "${name}"`,
      toolError: (_turn, name, content) => `Subagent tool "${name}" error: ${content}`,
      toolThrew: (_turn, name, content) => `Subagent tool "${name}" threw: ${content}`,
    },
  });

  let stopReason = result.stopReason;
  if (result.turnsUsed >= sub.maxTurns && stopReason === 'unknown') {
    stopReason = 'max_turns';
  }

  const finalAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
  const finalOutput = finalAssistantMsg?.content ?? '';

  return { turnsUsed: result.turnsUsed, totalToolCalls: result.totalToolCalls, tokenUsage: result.tokenUsage, stopReason, finalOutput, errors: result.errors };
}

// ── task executor ────────────────────────────────────────────────────────────

export const task: ToolExecutor = async (args, ctx) => {
  const v = validateArgs(TaskArgs, args);
  if (!v.ok) return { content: v.error, isError: true };

  const { description, prompt, subagent_name } = v.data;

  if (!ctx.subagent) {
    return {
      content: 'Error: subagent support not configured. Set subagent in the tool context to use the task tool.',
      isError: true,
    };
  }

  const name = subagent_name ?? 'subagent';
  ctx.logger.info('Spawning subagent', { name, description, maxTurns: ctx.subagent.maxTurns });

  const sub = ctx.subagent;
  const result = await runSubagent(sub, ctx.sandboxDir, prompt);

  ctx.logger.info('Subagent complete', {
    name,
    turnsUsed: result.turnsUsed,
    totalToolCalls: result.totalToolCalls,
    stopReason: result.stopReason,
    tokens: result.tokenUsage.total,
  });

  const summary = [
    result.finalOutput ? result.finalOutput.slice(0, 2000) : '',
    `\n--- subagent report ---`,
    `description: ${description}`,
    `turns: ${result.turnsUsed}/${sub.maxTurns}`,
    `tool calls: ${result.totalToolCalls}`,
    `tokens: ${result.tokenUsage.total ?? 0}`,
    `stop reason: ${result.stopReason}`,
    result.errors.length > 0 ? `errors: ${result.errors.join('; ')}` : '',
  ].filter(Boolean).join('\n');

  return { content: summary, isError: result.errors.length > 0 };
};
