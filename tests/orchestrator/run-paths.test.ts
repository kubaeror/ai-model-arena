import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { dump } from 'js-yaml';
import { resolveScenarioPath } from '../../src/config.js';
import { outputRoot, modelDirSegment } from '../../src/paths.js';
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
  anthropic: {
    id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], models: {
      'claude-3-7-sonnet': {
        id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet',
        attachment: true, reasoning: true, temperature: true, tool_call: true,
        cost: { input: 3, output: 15 },
        limit: { context: 200000, output: 8192 },
      },
      'claude-3.7': {
        id: 'claude-3.7', name: 'claude-3.7',
        attachment: false, reasoning: false, temperature: true, tool_call: true,
        cost: { input: 3, output: 15 },
        limit: { context: 200000, output: 8192 },
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

test('modelDirSegment always yields one safe path segment', () => {
  assert.equal(modelDirSegment('Claude 3.7 Sonnet'), 'Claude_3.7_Sonnet');
  assert.equal(modelDirSegment('claude-3.7'), 'claude-3.7');
  assert.equal(modelDirSegment('openai/gpt-4o'), 'openai_gpt-4o');
  assert.equal(modelDirSegment('a..b'), 'a_b');
  assert.equal(modelDirSegment('..'), '_');
  assert.equal(modelDirSegment('.'), '_');
  assert.equal(modelDirSegment(''), '_');

  for (const input of ['../../etc/passwd', '..\\..\\evil', '~\0x', '...', ' . ']) {
    const segment = modelDirSegment(input);
    assert.ok(segment.length > 0, `empty segment for ${JSON.stringify(input)}`);
    assert.notEqual(segment, '.', `dot segment for ${JSON.stringify(input)}`);
    assert.notEqual(segment, '..', `parent segment for ${JSON.stringify(input)}`);
    assert.ok(
      !segment.includes('/') && !segment.includes('\\') && !segment.includes('\0'),
      `unsafe segment ${segment} for ${JSON.stringify(input)}`,
    );
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

    await assert.rejects(
      startRun({ scenario: scenarioFile, models: ['GPT-4o'] }),
      /Invalid identifier/,
      'a missing source must fail closed for explicit scenario paths',
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
      assert.equal(model.outputDir, path.join(outputRoot(), modelDirSegment('openai/gpt-4o'), spec.runId));
    }

    // A dotted basename is sanitized into the run-id stem, not rejected.
    const dottedScenario = path.join(tmp, 'smoke.test.yaml');
    fs.writeFileSync(dottedScenario, dump({
      name: 'smoke', systemPrompt: 'You are a test agent.', task: 'Finish immediately.',
    }));
    const dottedSpec = await startRun({ scenario: dottedScenario, models: ['GPT-4o'], source: 'cli' });
    assert.match(dottedSpec.runId, /^smoke\.test_/, 'dotted CLI stems are sanitized, not rejected');
    assert.ok(
      !dottedSpec.runId.includes('/') && !dottedSpec.runId.includes('\\'),
      'dotted runId must stay a single path segment',
    );
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    restoreEnv();
  }
});

test('startRun accepts display names, dotted names, and canonical ids with contained output dirs', async () => {
  const tmp = freshDb();
  await seedCatalog();

  try {
    const { startRun } = await import('../../src/orchestrator/run-lifecycle.js');
    const cases = [
      { lookup: 'Claude 3.7 Sonnet', canonicalId: 'anthropic/claude-3-7-sonnet' },
      { lookup: 'claude-3.7', canonicalId: 'anthropic/claude-3.7' },
      { lookup: 'openai/gpt-4o', canonicalId: 'openai/gpt-4o' },
      { lookup: 'GPT-4o', canonicalId: 'openai/gpt-4o' },
    ];
    for (const { lookup, canonicalId } of cases) {
      const spec = await startRun({ scenario: 'express-rest', models: [lookup], source: 'dashboard' });
      const model = spec.models[0]!;
      assert.equal(model.model, lookup, 'spec.models[].model keeps the original lookup key');
      assert.equal(
        model.outputDir,
        path.join(outputRoot(), modelDirSegment(canonicalId), spec.runId),
        `output dir for "${lookup}" derives from the resolved canonical id`,
      );
      assert.ok(
        isWithin(outputRoot(), model.outputDir),
        `output dir for "${lookup}" must stay within ${outputRoot()}`,
      );
    }
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    restoreEnv();
  }
});
