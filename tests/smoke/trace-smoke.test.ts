// Trace smoke test (node:test format) — validates the local trace recorder
// writes trace-meta.json with span tree even without an OTLP exporter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAgentLoopTraced } from '../../src/observability/instrument-loop.js';
import { readTraceMeta } from '../../src/observability/trace-meta.js';
import { ConversationLogger } from '../../src/logger/conversation-logger.js';
import { createLogger } from '../../src/logger/pino-logger.js';

test('smoke: trace spans written with local trace recorder', { timeout: 30_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-trace-'));
  const convPath = path.join(tmp, 'conversation.json');

  const logger = createLogger('smoke');

  const mockAdapter = {
    async sendMessage() {
      return {
        text: 'done',
        toolCalls: [{ id: 'tc1', name: 'task_complete', arguments: {} }],
        usage: { prompt: 10, completion: 5, total: 15 },
        stopReason: 'tool_use',
      };
    },
  };

  const executors = {
    task_complete: async () => ({ content: 'Task complete', isError: false }),
  };

  const conv = new ConversationLogger(convPath, {
    model: 'mock-model', scenario: 'mock', runId: 'mock-run', startedAt: new Date().toISOString(),
  });

  const { result } = await runAgentLoopTraced({
    adapter: mockAdapter as any,
    tools: [{ name: 'task_complete', description: 'stop', parameters: {} }],
    executors,
    systemPrompt: 'sys',
    task: 'do it',
    maxTurns: 3,
    toolCtx: { sandboxDir: tmp, logger, shellTimeoutMs: 30000, maxShellOutputBytes: 524288 },
    conv,
    logger,
    provider: 'mock',
    model: 'mock-model',
    temperature: 0.2,
    maxTokens: 128,
    scenario: 'mock',
    runId: 'mock-run',
    modelConfig: 'mock',
    outputDir: tmp,
  });

  const meta = readTraceMeta(tmp);
  const types = meta?.spans.map((s: any) => s.type) ?? [];
  assert.equal(result.stopReason, 'task_complete');
  assert.ok(meta, 'trace-meta.json should exist');
  assert.ok(types.includes('root'), 'should have root span');
  assert.ok(types.includes('chat'), 'should have chat span');
  assert.ok(types.includes('execute_tool'), 'should have execute_tool span');

  try { fs.rmSync(tmp, { recursive: true }); } catch { /* cleanup */ }
});
