import fs from 'node:fs';
import path from 'node:path';
import type { RunResult } from './result-logger.js';

export interface ComparisonEntry {
  model: string;
  runId: string;
  resultPath: string;
  result?: RunResult;
  error?: string;
}

export interface ComparisonMeta {
  scenario: string;
  startedAt: string;
  finishedAt?: string;
}

function fmtMs(ms: number): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/**
 * Write a per-run comparison report aggregating every model's result.json.
 * Produces both comparison.md (human) and comparison.json (machine).
 */
export function writeComparison(
  base: string,
  entries: ComparisonEntry[],
  meta: ComparisonMeta,
): { mdPath: string; jsonPath: string } {
  const finishedAt = meta.finishedAt ?? new Date().toISOString();
  const jsonPath = `${base}.json`;
  const mdPath = `${base}.md`;

  // ── comparison.json ──
  const summary = {
    scenario: meta.scenario,
    startedAt: meta.startedAt,
    finishedAt,
    models: entries.map((e) => ({
      model: e.model,
      runId: e.runId,
      success: e.result?.success ?? false,
      turnsUsed: e.result?.turnsUsed ?? 0,
      maxTurns: e.result?.maxTurns ?? 0,
      totalToolCalls: e.result?.totalToolCalls ?? 0,
      toolsCalled: e.result?.toolsCalled ?? [],
      tokenUsage: e.result?.tokenUsage ?? {},
      stopReason: e.result?.stopReason ?? (e.error ? 'crashed' : 'unknown'),
      durationMs: e.result?.durationMs ?? 0,
      successCriteriaPassed: e.result?.successCriteria?.passed ?? false,
      errors: e.result?.errors ?? (e.error ? [e.error] : []),
      resultPath: e.resultPath,
    })),
  };
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  // ── comparison.md ──
  const lines: string[] = [];
  lines.push(`# Comparison: ${meta.scenario}`, '');
  lines.push(`- **Scenario:** ${meta.scenario}`);
  lines.push(`- **Started:** ${meta.startedAt}`);
  lines.push(`- **Finished:** ${finishedAt}`);
  lines.push(`- **Models:** ${entries.length}`, '');
  lines.push('| Model | Result | Turns | Tool calls | Duration | Tokens (p/c/t) | Stop | Success criteria |');
  lines.push('|-------|:------:|:-----:|:----------:|:--------:|:--------------:|:----:|:-----------------:|');
  for (const e of entries) {
    const r = e.result;
    const result = e.error ? '💥 CRASH' : r?.success ? '✅ PASS' : '❌ FAIL';
    const turns = r ? `${r.turnsUsed}/${r.maxTurns}` : '-';
    const tools = r?.totalToolCalls ?? '-';
    const dur = r ? fmtMs(r.durationMs) : '-';
    const tok = r?.tokenUsage
      ? `${r.tokenUsage.prompt ?? '-'}/${r.tokenUsage.completion ?? '-'}/${r.tokenUsage.total ?? '-'}`
      : '-';
    const stop = r?.stopReason ?? (e.error ? 'crashed' : '-');
    const sc = r?.successCriteria
      ? `${r.successCriteria.passed ? 'pass' : 'fail'} (exit ${r.successCriteria.exitCode ?? '-'})`
      : '-';
    lines.push(`| ${e.model} | ${result} | ${turns} | ${tools} | ${dur} | ${tok} | ${stop} | ${sc} |`);
  }
  lines.push('');

  for (const e of entries) {
    lines.push(`## ${e.model}`, '');
    if (e.error) {
      lines.push(`> ⚠️ ${e.error}`, '');
      continue;
    }
    const r = e.result;
    if (!r) continue;
    lines.push(`- **Run ID:** ${r.runId}`);
    lines.push(`- **Result:** ${r.success ? '✅ PASS' : '❌ FAIL'} (stop: ${r.stopReason})`);
    lines.push(`- **Turns:** ${r.turnsUsed} / ${r.maxTurns}`);
    lines.push(`- **Tool calls:** ${r.totalToolCalls} — ${r.toolsCalled.map((t) => `${t.name}×${t.count}`).join(', ') || 'none'}`);
    lines.push(`- **Duration:** ${fmtMs(r.durationMs)}`);
    lines.push(`- **Tokens:** prompt=${r.tokenUsage.prompt ?? 'n/a'} completion=${r.tokenUsage.completion ?? 'n/a'} total=${r.tokenUsage.total ?? 'n/a'}`);
    if (r.successCriteria) {
      lines.push(`- **Success criteria:** command=\`${r.successCriteria.command ?? 'n/a'}\` expected exit=${r.successCriteria.expectedExitCode} actual exit=${r.successCriteria.exitCode ?? 'n/a'} passed=${r.successCriteria.passed}`);
    }
    if (r.errors.length) {
      lines.push(`- **Errors:**`);
      for (const er of r.errors) lines.push(`  - ${er.slice(0, 400)}`);
    }
    lines.push(`- **Artifacts:** \`outputs/${e.model}/${e.runId}/\` (conversation.json, report.md, files/)`, '');
  }

  fs.writeFileSync(mdPath, lines.join('\n') + '\n');
  return { mdPath, jsonPath };
}
