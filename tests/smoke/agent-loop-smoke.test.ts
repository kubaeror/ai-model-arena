// Smoke test (node:test format) — agent loop + tools + sandbox + loggers
// with a stub adapter (no API key / network required).
// Included in coverage via .c8-test-list.txt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAgentLoop } from '../../src/agent-loop/index.js';
import { TOOL_DEFINITIONS, buildToolExecutors } from '../../src/tools/index.js';
import { ConversationLogger } from '../../src/logger/conversation-logger.js';
import { Sandbox, safeResolve } from '../../src/sandbox/sandbox.js';
import { createLogger } from '../../src/logger/pino-logger.js';

class StubAdapter {
  private i = 0;
  private script = [
    {
      text: 'I will create hello.txt, then finish.',
      toolCalls: [{ id: 'call_1', name: 'write_file', arguments: { path: 'hello.txt', content: 'hello world' } }],
    },
    {
      text: 'All done.',
      toolCalls: [{ id: 'call_2', name: 'task_complete', arguments: { summary: 'wrote hello.txt' } }],
    },
  ];

  async sendMessage() {
    const r = this.script[this.i++] ?? { text: 'no script', toolCalls: [] };
    return { ...r, usage: { prompt: 10, completion: 5, total: 15 }, stopReason: 'tool_calls' };
  }
}

test('smoke: agent loop completes with stub adapter', { timeout: 30_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-stub-'));
  const sandboxDir = path.join(tmp, 'files');
  const sandbox = new Sandbox(sandboxDir);
  sandbox.ensure();
  fs.writeFileSync(path.join(sandboxDir, 'README.md'), '# pre-existing\n');

  const convPath = path.join(tmp, 'conversation.json');
  const conv = new ConversationLogger(convPath, {
    model: 'stub', scenario: 'stub-smoke', runId: 'stub', startedAt: new Date().toISOString(),
  });

  const logger = createLogger('smoke', 'info');
  const result = await runAgentLoop({
    adapter: new StubAdapter() as any,
    tools: TOOL_DEFINITIONS,
    executors: buildToolExecutors(),
    systemPrompt: 'You are a stub agent.',
    task: 'Create hello.txt then call task_complete.',
    maxTurns: 5,
    toolCtx: { sandboxDir, logger, shellTimeoutMs: 5000, maxShellOutputBytes: 65536 },
    conv,
    logger,
  });

  assert.equal(result.stopReason, 'task_complete');
  assert.equal(result.turnsUsed, 2);
  assert.equal(result.totalToolCalls, 2);
  assert.equal(result.tokenUsage.total, 30);

  const created = fs.readFileSync(path.join(sandboxDir, 'hello.txt'), 'utf8');
  assert.equal(created, 'hello world');

  // conversation.json written and well-formed
  const convFile = JSON.parse(fs.readFileSync(convPath, 'utf8'));
  assert.ok(convFile.entries.length >= 4);

  // path-traversal protection
  assert.throws(() => safeResolve(sandboxDir, '../evil.txt'), /escape/i);
  assert.throws(() => safeResolve(sandboxDir, '../../etc/passwd'), /escape/i);

  // read_file executor works
  const readResult = await buildToolExecutors().read_file(
    { path: 'hello.txt' },
    { sandboxDir, logger, shellTimeoutMs: 5000, maxShellOutputBytes: 65536 },
  );
  assert.match(readResult.content, /hello world/);

  try { fs.rmSync(tmp, { recursive: true }); } catch { /* cleanup */ }
});
