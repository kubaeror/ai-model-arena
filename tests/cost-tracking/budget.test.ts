import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadBudgetConfig,
  checkBudget,
  addSpend,
  reserveBudget,
  releaseReservation,
  resetBudgetCache,
  budgetStateRoot,
} from '../../src/cost-tracking/budget.js';

const CONFIG = `
global:
  daily: 10
stateFile: outputs/.budget-state.json
`;

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-budget-'));
  const rootDir = path.join(tmp, 'run');
  fs.mkdirSync(path.join(rootDir, 'outputs'), { recursive: true });
  const configPath = path.join(tmp, 'config.yaml');
  fs.writeFileSync(configPath, CONFIG);
  const statePath = path.join(rootDir, 'outputs', '.budget-state.json');
  return { tmp, rootDir, configPath, statePath };
}

function writeState(statePath: string, overrides: Record<string, unknown> = {}) {
  const dayKey = new Date().toISOString().slice(0, 10);
  const state = {
    global: { daily: {}, monthly: {} },
    models: { 'gpt-4o': { daily: { [dayKey]: 15 }, monthly: {} } },
    lastReset: new Date().toISOString(),
    ...overrides,
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

test('checkBudget blocks spend past the daily limit', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  try {
    writeState(statePath);
    loadBudgetConfig(configPath);
    const result = checkBudget('gpt-4o', rootDir);
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? '', /daily/i);
    assert.equal(result.percentUsed, 150);
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reservations are persisted and survive a new BudgetManager instance over the same state file', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  try {
    writeState(statePath, { models: {} });
    loadBudgetConfig(configPath);
    assert.equal(reserveBudget('gpt-4o', 4, rootDir).ok, true);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.reservations?.['gpt-4o']?.length, 1, 'reservation serialized into the state file');

    resetBudgetCache();
    loadBudgetConfig(configPath);
    const blocked = reserveBudget('gpt-4o', 7, rootDir);
    assert.equal(blocked.ok, false, 'persisted reservation still counted by a new instance');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('releaseReservation removes the persisted reservation', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  try {
    writeState(statePath, { models: {} });
    loadBudgetConfig(configPath);
    reserveBudget('gpt-4o', 4, rootDir);
    releaseReservation('gpt-4o', 4, 0, rootDir);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.reservations?.['gpt-4o']?.length ?? 0, 0, 'released reservation removed from state file');

    resetBudgetCache();
    loadBudgetConfig(configPath);
    assert.equal(reserveBudget('gpt-4o', 7, rootDir).ok, true, 'released reservation no longer counted');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('releaseReservation removes the entry matching the released amount, not the first today entry', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  try {
    writeState(statePath, { models: {} });
    loadBudgetConfig(configPath);
    assert.equal(reserveBudget('gpt-4o', 2, rootDir).ok, true);
    assert.equal(reserveBudget('gpt-4o', 5, rootDir).ok, true);

    // Release the LATER reservation (5) before the earlier one (2).
    releaseReservation('gpt-4o', 5, 0, rootDir);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const entries = persisted.reservations?.['gpt-4o'] ?? [];
    assert.equal(entries.length, 1, 'only the released reservation is removed');
    assert.equal(entries[0].amount, 2, 'the unreleased reservation (2) survives, not the released one (5)');

    // A fresh instance over the same file must count only the remaining 2.
    resetBudgetCache();
    loadBudgetConfig(configPath);
    // 2 remaining + 6 = 8 <= 10 -> allowed. If 5 had been left behind, 5 + 6 = 11 would block.
    assert.equal(reserveBudget('gpt-4o', 6, rootDir).ok, true, 'remaining reservation is 2, not 5');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('releaseReservation for a never-persisted amount leaves the state file untouched', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  try {
    writeState(statePath, { models: {} });
    loadBudgetConfig(configPath);
    assert.equal(reserveBudget('gpt-4o', 4, rootDir).ok, true);

    // Fresh instance hydrates the persisted reservation (4) into memory.
    resetBudgetCache();
    loadBudgetConfig(configPath);

    // Release an amount that was never reserved or persisted (3 != 4).
    releaseReservation('gpt-4o', 3, 0, rootDir);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const entries = persisted.reservations?.['gpt-4o'] ?? [];
    assert.equal(entries.length, 1, 'no persisted entry is removed');
    assert.equal(entries[0].amount, 4, 'unrelated persisted entry survives');

    // The 4 reservation must still count after restart.
    resetBudgetCache();
    loadBudgetConfig(configPath);
    assert.equal(reserveBudget('gpt-4o', 7, rootDir).ok, false, 'reservation remains counted after restart');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('addSpend ignores prototype-polluting model names', async () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath } = setup();
  try {
    loadBudgetConfig(configPath);
    await addSpend('__proto__', 1, rootDir);
    assert.equal((Object.prototype as unknown as Record<string, unknown>).daily, undefined,
      'Object.prototype must not gain a daily ledger');
    assert.equal((Object.prototype as unknown as Record<string, unknown>).monthly, undefined);
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reserveBudget ignores prototype-polluting model names', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  try {
    loadBudgetConfig(configPath);
    writeState(statePath); // ensure the state file exists before assertions
    const result = reserveBudget('constructor', 1, rootDir);
    assert.equal(result.ok, true);
    assert.equal((Object.prototype as unknown as Record<string, unknown>).push, undefined,
      'Object.prototype must not gain array methods');
    assert.ok(!Object.prototype.hasOwnProperty.call(
      JSON.parse(fs.readFileSync(statePath, 'utf8')).reservations ?? {}, 'constructor'),
      'state file must not contain a reserved-key reservation');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('budgetStateRoot follows OUTPUT_ROOT when set, else the base root', () => {
  const prev = process.env.OUTPUT_ROOT;
  try {
    delete process.env.OUTPUT_ROOT;
    assert.equal(budgetStateRoot('/repo'), '/repo');
    process.env.OUTPUT_ROOT = '/var/arena/outputs';
    assert.equal(budgetStateRoot('/repo'), '/var/arena/outputs');
  } finally {
    if (prev === undefined) delete process.env.OUTPUT_ROOT;
    else process.env.OUTPUT_ROOT = prev;
  }
});

test('checkBudget reads the ledger under OUTPUT_ROOT (containerized deployments)', () => {
  resetBudgetCache();
  const { tmp, configPath } = setup();
  const prev = process.env.OUTPUT_ROOT;
  process.env.OUTPUT_ROOT = tmp; // ledger must live at <OUTPUT_ROOT>/outputs/.budget-state.json
  try {
    fs.mkdirSync(path.join(tmp, 'outputs'), { recursive: true });
    writeState(path.join(tmp, 'outputs', '.budget-state.json')); // gpt-4o daily spent = 15, limit 10
    loadBudgetConfig(configPath);
    const result = checkBudget('gpt-4o', budgetStateRoot('/whatever/else'), false);
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? '', /daily/i);
  } finally {
    if (prev === undefined) delete process.env.OUTPUT_ROOT;
    else process.env.OUTPUT_ROOT = prev;
    resetBudgetCache();
  }
});
