import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadBudgetConfig,
  checkBudget,
  reserveBudget,
  releaseReservation,
  resetBudgetCache,
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
