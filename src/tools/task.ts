import { z } from 'zod/v4';
import type { ToolExecutor, ChatMessage, TokenUsage, SubagentConfig } from '../types.js';
import { TASK_COMPLETE_TOOL } from './schema.js';

const TaskArgs = z.object({
  description: z.string().min(1).max(100),
  prompt: z.string().min(1),
  subagent_name: z.string().optional(),
}).strict();

const MAX_SUBAGENT_TOOL_RESULT_CHARS = 30_000;

function validateArgs<T>(schema: z.ZodType<T>, args: Record<string, unknown>): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(args);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: `Invalid arguments: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
}

function truncate(s: string, max = MAX_SUBAGENT_TOOL_RESULT_CHARS): string {
  return s.length <= max ? s : s.slice(0, max) + '\n…[truncated]';
}

/**
 * Inlined subagent loop. Avoids circular import from agent-loop/loop.ts
 * by accepting the adapter as a function on the SubagentConfig.
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

  const usage: TokenUsage = {};
  const errors: string[] = [];
  let totalToolCalls = 0;
  let stopReason = 'unknown';
  const maxTurns = sub.maxTurns;
  let turnsUsed = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    turnsUsed = turn;
    let response;
    try {
      response = await sub.sendMessage(messages, sub.tools);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Subagent turn ${turn}: ${msg}`);
      stopReason = 'api_error';
      break;
    }

    messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });

    if (response.usage) {
      usage.prompt = (usage.prompt ?? 0) + (response.usage.prompt ?? 0);
      usage.completion = (usage.completion ?? 0) + (response.usage.completion ?? 0);
      usage.total = (usage.total ?? 0) + (response.usage.total ?? 0);
    }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      stopReason = 'no_tool_calls';
      break;
    }

    const wantsComplete = response.toolCalls.some(tc => tc.name === TASK_COMPLETE_TOOL);

    for (const tc of response.toolCalls) {
      totalToolCalls++;
      const executor = sub.executors[tc.name];
      let content: string;
      let isError = false;
      if (!executor) {
        content = `Error: unknown tool "${tc.name}"`;
        isError = true;
        errors.push(`Subagent: unknown tool "${tc.name}"`);
      } else {
        try {
          const res = await executor(tc.arguments, {
            sandboxDir,
            logger: sub.logger,
            shellTimeoutMs: sub.shellTimeoutMs,
            maxShellOutputBytes: sub.maxShellOutputBytes,
            shellPolicy: sub.shellPolicy,
            webAccess: sub.webAccess,
            executionProfile: sub.executionProfile,
            allowedTools: sub.allowedTools,
          });
          content = res.content;
          isError = res.isError;
          if (isError) errors.push(`Subagent tool "${tc.name}" error: ${content}`);
        } catch (err) {
          content = `Error executing "${tc.name}": ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
          errors.push(`Subagent tool "${tc.name}" threw: ${content}`);
        }
      }
      content = truncate(content);
      messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content });
    }

    if (wantsComplete) {
      stopReason = 'task_complete';
      break;
    }
  }

  if (turnsUsed >= maxTurns && stopReason === 'unknown') {
    stopReason = 'max_turns';
  }

  const finalAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
  const finalOutput = finalAssistantMsg?.content ?? '';

  return { turnsUsed, totalToolCalls, tokenUsage: usage, stopReason, finalOutput, errors };
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
