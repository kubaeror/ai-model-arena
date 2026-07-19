import fs from 'node:fs';
import path from 'node:path';
import type { ConversationFile, ConversationEntry } from './conversation-logger.js';
import type { RunResult } from './result-logger.js';

const SNIPPET = 240;
const RESULT_SNIPPET = 600;

function snippet(s: string | null | undefined, max = SNIPPET): string {
  if (s == null) return '';
  const str = String(s).replace(/\r/g, '');
  return str.length > max ? str.slice(0, max) + ' …[truncated]' : str;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function renderTimeline(entries: readonly ConversationEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    const tag = e.turn != null ? `turn ${e.turn}` : '';
    switch (e.type) {
      case 'system':
        lines.push(`### [${e.timestamp}] System prompt\n\n${snippet(e.content)}\n`);
        break;
      case 'user':
        lines.push(`### [${e.timestamp}] User task ${tag}\n\n${snippet(e.content)}\n`);
        break;
      case 'assistant':
        lines.push(`### [${e.timestamp}] Assistant ${tag}` + (e.stopReason ? ` (stop: ${e.stopReason})` : ''));
        if (e.content) lines.push('', snippet(e.content));
        if (e.usage && (e.usage.total != null || e.usage.prompt != null)) {
          lines.push('', `_tokens: prompt=${e.usage.prompt ?? 'n/a'} completion=${e.usage.completion ?? 'n/a'} total=${e.usage.total ?? 'n/a'}_`);
        }
        if (e.toolCalls && e.toolCalls.length) {
          lines.push('', '**Tool calls:**');
          for (const tc of e.toolCalls) lines.push(`- \`${tc.name}\` ${snippet(JSON.stringify(tc.arguments))}`);
        }
        lines.push('');
        break;
      case 'tool_call':
        lines.push(`### [${e.timestamp}] Tool call ${tag}: \`${e.toolName}\`\n\n${snippet(JSON.stringify(e.meta?.args))}\n`);
        break;
      case 'tool_result':
        lines.push(`### [${e.timestamp}] Tool result ${tag}: \`${e.toolName}\`${e.isError ? ' (ERROR)' : ''}\n\n\`\`\`\n${snippet(e.toolResult, RESULT_SNIPPET)}\n\`\`\`\n`);
        break;
      case 'error':
        lines.push(`### [${e.timestamp}] ERROR ${tag}\n\n${snippet(e.content)}\n`);
        break;
      case 'info':
        lines.push(`_[${e.timestamp}] ${snippet(e.content)}_`);
        break;
    }
  }
  return lines.join('\n');
}

/** Generate a human-readable report.md from the result + conversation. */
export function writeReport(
  reportPath: string,
  result: RunResult,
  conversation: ConversationFile,
): void {
  const tools = result.toolsCalled.length
    ? result.toolsCalled.map((t) => `\`${t.name}\` (${t.count})`).join(', ')
    : '—';
  const usage = result.tokenUsage;
  const sc = result.successCriteria;
  const lines: string[] = [
    `# Run Report`,
    ``,
    `- **Model:** ${result.model}`,
    `- **Scenario:** ${result.scenario}`,
    `- **Run ID:** ${result.runId}`,
    `- **Started:** ${result.startedAt}`,
    `- **Finished:** ${result.finishedAt}`,
    `- **Duration:** ${fmtMs(result.durationMs)}`,
    `- **Turns used:** ${result.turnsUsed} / ${result.maxTurns}`,
    `- **Tool calls:** ${result.totalToolCalls} total — ${tools}`,
    `- **Token usage:** prompt=${usage.prompt ?? 'n/a'} completion=${usage.completion ?? 'n/a'} total=${usage.total ?? 'n/a'}`,
    `- **Stop reason:** ${result.stopReason ?? 'n/a'}`,
    `- **Result:** ${result.success ? '✅ PASS' : '❌ FAIL'}`,
  ];

  if (sc) {
    lines.push(
      `- **Success criteria:** command=${sc.command ?? 'n/a'} · expected exit=${sc.expectedExitCode} · actual exit=${sc.exitCode ?? 'n/a'} · passed=${sc.passed ?? false}` +
        (sc.outputContainsPassed != null ? ` · output-contains=${sc.outputContainsPassed}` : ''),
    );
  }
  if (result.errors.length) {
    lines.push(`- **Errors:**`);
    for (const er of result.errors) lines.push(`  - ${snippet(er, 400)}`);
  } else {
    lines.push(`- **Errors:** none`);
  }

  lines.push('', `## Timeline`, '', renderTimeline(conversation.entries));

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8');
}
