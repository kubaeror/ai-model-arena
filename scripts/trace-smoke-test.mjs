// End-to-end observability smoke test: run a mock agent loop under tracing,
// assert a full span tree (invoke_agent + chat + execute_tool) is written to
// trace-meta.json even when the OTLP exporter cannot reach a backend.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startOtel, shutdownOtel } from '../dist/observability/otel.js';
import { runAgentLoopTraced } from '../dist/observability/instrument-loop.js';
import { readTraceMeta } from '../dist/observability/trace-meta.js';
import { ConversationLogger } from '../dist/logger/conversation-logger.js';
import { createLogger } from '../dist/logger/pino-logger.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-trace-'));
const convPath = path.join(tmp, 'conversation.json');
const outputDir = tmp;

const logger = createLogger('smoke');
// Tracing ON, exporter pointed at a dead port -> spans still created + flushed locally.
process.env.OTEL_ENABLED = 'true';
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9'; // nothing listening
process.env.OTEL_TRACE_UI_BASE_URL = 'http://localhost:16686';
startOtel();

const mockAdapter = {
  async sendMessage(_messages, _tools) {
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
  model: 'mock-model', scenario: 'mock-scenario', runId: 'mock-run', startedAt: new Date().toISOString(),
});

try {
  const { result, trace } = await runAgentLoopTraced({
    adapter: mockAdapter,
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
    scenario: 'mock-scenario',
    runId: 'mock-run',
    modelConfig: 'mock',
    outputDir,
  });

  const meta = readTraceMeta(outputDir);
  const types = (meta?.spans.map((s) => s.type) ?? []);
  const ok = result.stopReason === 'task_complete' && meta && types.includes('root') && types.includes('chat') && types.includes('execute_tool');
  console.log('loop stopReason:', result.stopReason);
  console.log('trace traceId:', meta?.traceId);
  console.log('span types:', types.join(','));
  console.log('externalUrl:', meta?.externalUrl);
  console.log('TRACE_TEST_PASS:', ok ? 'true' : 'false');
  if (!ok) process.exitCode = 1;
} finally {
  await shutdownOtel();
}
