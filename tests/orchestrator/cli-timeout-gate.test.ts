import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { dump } from 'js-yaml';
import { InMemoryQueue } from '../../src/queue/in-memory.js';
import { stopRun } from '../../src/orchestrator/run-lifecycle.js';
import { getRunRecord } from '../../src/db/runs.js';
import type { Task } from '../../src/queue/types.js';
import type { Logger } from '../../src/types.js';

const MODELS_DEV = {
  openai: {
    id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
      'gpt-4o': {
        id: 'gpt-4o', name: 'GPT-4o',
        attachment: true, reasoning: false, temperature: true, tool_call: true,
        cost: { input: 2.5, output: 10 },
        limit: { context: 128000, output: 16384 },
      },
    },
  },
};

const ORIG_ENV: Record<string, string | undefined> = {
  AI_ARENA_ROOT: process.env.AI_ARENA_ROOT,
  DB_DRIVER: process.env.DB_DRIVER,
  QUEUE_DRIVER: process.env.QUEUE_DRIVER,
  ARENA_DB_PATH: process.env.ARENA_DB_PATH,
  OUTPUT_ROOT: process.env.OUTPUT_ROOT,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIG_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function freshRoot(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-cli-timeout-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.AI_ARENA_ROOT = tmp;
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  initDb(process.env.ARENA_DB_PATH);
  fs.mkdirSync(path.join(tmp, 'configs', 'scenarios'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'configs', 'budget.yaml'), dump({
    global: { daily: 1000, monthly: 1000 },
    thresholds: { warn: 80, block: 100 },
    stateFile: '.budget-state.json',
  }));
  fs.writeFileSync(path.join(tmp, 'configs', 'scenarios', 'express-rest.yaml'), dump({
    name: 'express-rest', systemPrompt: 'Build an express REST api', task: 'Build an express REST api', maxTurns: 20,
  }));
  return tmp;
}

async function seedCatalog(): Promise<void> {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => MODELS_DEV,
    text: async () => JSON.stringify(MODELS_DEV),
  } as unknown as Response)) as typeof fetch;
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
  } finally {
    globalThis.fetch = origFetch;
  }
}

const silent: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => silent,
};

test('CLI timeout skips finalization for a stopped run with a live signal and non-terminal models', async () => {
  const tmp = freshRoot();
  await seedCatalog();
  const { runScenarioForModels } = await import('../../src/orchestrator/orchestrator.js');

  let runId: string | undefined;
  const orig = InMemoryQueue.prototype.enqueue;
  InMemoryQueue.prototype.enqueue = async function (task: Task): Promise<void> {
    await orig.call(this, task);
    if (!runId) {
      runId = String(task.config.modelRunId);
      await stopRun(runId);
    }
  };
  try {
    await runScenarioForModels({ scenario: 'express-rest', models: ['GPT-4o'], source: 'cli', timeoutMs: 0, logger: silent });
  } finally {
    InMemoryQueue.prototype.enqueue = orig;
  }

  try {
    assert.ok(runId, 'a task must have been enqueued');
    const rec = await getRunRecord(runId!);
    assert.equal(rec?.status, 'stopped', 'a stop-blocked run must not be force-finalized by the timeout path');
    assert.equal(rec?.perModel[0]?.status, 'running', 'the runner ack row must be left non-terminal');
  } finally {
    restoreEnv();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI timeout still finalizes a non-stopped run with partial results', async () => {
  const tmp = freshRoot();
  await seedCatalog();
  const { runScenarioForModels } = await import('../../src/orchestrator/orchestrator.js');

  let runId: string | undefined;
  const orig = InMemoryQueue.prototype.enqueue;
  InMemoryQueue.prototype.enqueue = async function (task: Task): Promise<void> {
    if (!runId) runId = String(task.config.modelRunId);
    await orig.call(this, task);
  };
  try {
    await runScenarioForModels({ scenario: 'express-rest', models: ['GPT-4o'], source: 'cli', timeoutMs: 0, logger: silent });
  } finally {
    InMemoryQueue.prototype.enqueue = orig;
  }

  try {
    assert.ok(runId, 'a task must have been enqueued');
    const rec = await getRunRecord(runId!);
    assert.equal(rec?.status, 'completed', 'an unstoppable timeout keeps the force-finalize behavior');
  } finally {
    restoreEnv();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
