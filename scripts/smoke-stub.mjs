// Smoke test for the agent loop + tools + sandbox + loggers, using a stub
// adapter (no API key / network required). Run with:
//   npm run build && node scripts/smoke-stub.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAgentLoop } from '../dist/agent-loop/index.js';
import { TOOL_DEFINITIONS, buildToolExecutors } from '../dist/tools/index.js';
import { ConversationLogger } from '../dist/logger/conversation-logger.js';
import { writeReport } from '../dist/logger/report-logger.js';
import { writeResultJson } from '../dist/logger/result-logger.js';
import { Sandbox, safeResolve } from '../dist/sandbox/sandbox.js';
import { createLogger } from '../dist/logger/pino-logger.js';

// A scripted adapter: turn 1 -> write_file, turn 2 -> task_complete.
class StubAdapter {
  constructor() {
    this.i = 0;
    this.script = [
      {
        text: 'I will create hello.txt, then finish.',
        toolCalls: [{ id: 'call_1', name: 'write_file', arguments: { path: 'hello.txt', content: 'hello world' } }],
      },
      {
        text: 'All done.',
        toolCalls: [{ id: 'call_2', name: 'task_complete', arguments: { summary: 'wrote hello.txt' } }],
      },
    ];
  }
  async sendMessage(_messages, _tools) {
    const r = this.script[this.i++] ?? { text: 'no script', toolCalls: [] };
    return { ...r, usage: { prompt: 10, completion: 5, total: 15 }, stopReason: 'tool_calls' };
  }
}

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-stub-'));
const sandboxDir = path.join(tmp, 'files');
const sandbox = new Sandbox(sandboxDir);
sandbox.ensure();
fs.writeFileSync(path.join(sandboxDir, 'README.md'), '# pre-existing\n');

const startedAt = new Date().toISOString();
const convPath = path.join(tmp, 'conversation.json');
const conv = new ConversationLogger(convPath, { model: 'stub', scenario: 'stub-smoke', runId: 'stub', startedAt });

const logger = createLogger('smoke', 'info');
const result = await runAgentLoop({
  adapter: new StubAdapter(),
  tools: TOOL_DEFINITIONS,
  executors: buildToolExecutors(),
  systemPrompt: 'You are a stub agent.',
  task: 'Create hello.txt then call task_complete.',
  maxTurns: 5,
  toolCtx: { sandboxDir, logger, shellTimeoutMs: 5000, maxShellOutputBytes: 65536 },
  conv,
  logger,
});

// ── Assertions ──────────────────────────────────────────────────────────────
assert.equal(result.stopReason, 'task_complete', `expected task_complete, got ${result.stopReason}`);
assert.equal(result.turnsUsed, 2, `expected 2 turns, got ${result.turnsUsed}`);
assert.equal(result.totalToolCalls, 2, `expected 2 tool calls, got ${result.totalToolCalls}`);
assert.equal(result.toolsCalled.length, 2, 'expected 2 distinct tools');
assert.equal(result.toolsCalled[0].name, 'write_file');
assert.equal(result.toolsCalled[1].name, 'task_complete');
assert.equal(result.tokenUsage.total, 30, 'expected 30 total tokens (2x15)');

// The sandbox should contain the model-created file + the pre-existing one.
const created = fs.readFileSync(path.join(sandboxDir, 'hello.txt'), 'utf8');
assert.equal(created, 'hello world', 'hello.txt content mismatch');

// conversation.json written and well-formed.
const convFile = JSON.parse(fs.readFileSync(convPath, 'utf8'));
assert.ok(convFile.entries.length >= 4, 'conversation should have >= 4 entries');
const types = convFile.entries.map((e) => e.type);
assert.ok(types.includes('assistant'));
assert.ok(types.includes('tool_call'));
assert.ok(types.includes('tool_result'));

// report.md + result.json written.
const runResult = {
  model: 'stub', scenario: 'stub-smoke', runId: 'stub',
  startedAt, finishedAt: new Date().toISOString(),
  durationMs: 1000, turnsUsed: result.turnsUsed, maxTurns: 5,
  totalToolCalls: result.totalToolCalls, toolsCalled: result.toolsCalled,
  tokenUsage: result.tokenUsage, stopReason: result.stopReason,
  errors: result.errors, success: true,
};
writeResultJson(path.join(tmp, 'result.json'), runResult);
writeReport(path.join(tmp, 'report.md'), runResult, convFile);
assert.ok(fs.existsSync(path.join(tmp, 'report.md')));
assert.ok(fs.existsSync(path.join(tmp, 'result.json')));

// Path-traversal protection: '..' must be rejected.
assert.throws(() => safeResolve(sandboxDir, '../evil.txt'), /escape/i);
assert.throws(() => safeResolve(sandboxDir, '../../etc/passwd'), /escape/i);

// read_file executor works on the created file.
const { readFileSync: _r } = fs;
const readResult = await buildToolExecutors().read_file({ path: 'hello.txt' }, { sandboxDir, logger, shellTimeoutMs: 5000, maxShellOutputBytes: 65536 });
assert.match(readResult.content, /hello world/);

console.log('\n✅ SMOKE TEST PASSED');
console.log(`   stopReason=${result.stopReason} turns=${result.turnsUsed} toolCalls=${result.totalToolCalls}`);
console.log(`   artifacts in: ${tmp}`);
