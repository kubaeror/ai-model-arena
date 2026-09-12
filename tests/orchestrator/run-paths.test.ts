import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { dump } from 'js-yaml';
import { resolveScenarioPath } from '../../src/config.js';
import { outputRoot } from '../../src/paths.js';
import { isWithin } from '../../src/sandbox/sandbox.js';

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

function freshDb(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-run-paths-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.AI_ARENA_ROOT = tmp;
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  initDb(process.env.ARENA_DB_PATH);
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

test('resolveScenarioPath enforces bare names and gates explicit paths on the caller', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-scenario-path-'));
  try {
    assert.equal(resolveScenarioPath(dir, 'express-rest'), path.join(dir, 'express-rest.yaml'));

    for (const bad of ['../../evil', 'nested/evil', '/etc/passwd.yaml', 'smoke.yaml', '~evil']) {
      assert.throws(() => resolveScenarioPath(dir, bad), /Invalid identifier/, `must reject ${bad}`);
    }

    assert.equal(
      resolveScenarioPath(dir, '/tmp/arena-smoke.yaml', { allowPath: true }),
      '/tmp/arena-smoke.yaml',
      'CLI-sourced absolute paths pass through',
    );
    assert.equal(
      resolveScenarioPath(dir, 'nested/smoke.yaml', { allowPath: true }),
      path.resolve(dir, 'nested/smoke.yaml'),
      'CLI-sourced relative yaml paths resolve against the scenarios dir',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startRun rejects traversal identifiers and keeps CLI path runs inside the output root', async () => {
  const tmp = freshDb();
  await seedCatalog();

  const scenarioFile = path.join(tmp, 'smoke.yaml');
  fs.writeFileSync(scenarioFile, dump({
    name: 'smoke', systemPrompt: 'You are a test agent.', task: 'Finish immediately.',
  }));

  try {
    const { startRun } = await import('../../src/orchestrator/run-lifecycle.js');

    await assert.rejects(
      startRun({ scenario: '../../evil', models: ['GPT-4o'], source: 'dashboard' }),
      /Invalid identifier/,
      'a traversal scenario must be rejected at startRun',
    );

    await assert.rejects(
      startRun({ scenario: 'express-rest', models: ['../../evil'], source: 'dashboard' }),
      /Invalid identifier/,
      'a traversal model must be rejected at startRun',
    );

    await assert.rejects(
      startRun({ scenario: scenarioFile, models: ['GPT-4o'], source: 'dashboard' }),
      /Invalid identifier/,
      'non-CLI callers must not pass explicit scenario paths',
    );

    assert.ok(
      !fs.readdirSync(tmp).some((name) => name.startsWith('evil')),
      'rejected identifiers must not create directories outside outputRoot()',
    );

    const spec = await startRun({ scenario: scenarioFile, models: ['GPT-4o'], source: 'cli' });
    assert.match(spec.runId, /^smoke_/, 'CLI path runs derive a bare-name runId from the file stem');
    assert.ok(!spec.runId.includes('/') && !spec.runId.includes('\\'), 'runId must stay a single path segment');
    assert.equal(spec.scenario, scenarioFile, 'the original path is preserved for runner resolution');
    for (const model of spec.models) {
      assert.ok(
        isWithin(outputRoot(), model.outputDir),
        `output dir ${model.outputDir} must stay within ${outputRoot()}`,
      );
      assert.equal(model.outputDir, path.join(outputRoot(), 'GPT-4o', spec.runId));
    }
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    restoreEnv();
  }
});
