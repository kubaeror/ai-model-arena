import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadBudgetConfig, addSpend, checkBudget, resetBudgetCache,
  reserveBudget, releaseReservation, getBudgetStatus,
} from '../../src/cost-tracking/budget.js';

describe('addSpend callable and functional', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-budget-test-'));

  before(() => {
    fs.mkdirSync(tmp, { recursive: true });
    const budgetYaml = [
      'global:',
      '  daily: 10',
      '  monthly: 100',
      'models:',
      '  test-model:',
      '    daily: 5',
      '    monthly: 50',
      'thresholds:',
      '  warn: 80',
      '  block: 100',
      'stateFile: .budget-test-state.json',
    ].join('\n');
    fs.writeFileSync(path.join(tmp, 'budget.yaml'), budgetYaml);
    loadBudgetConfig(path.join(tmp, 'budget.yaml'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    resetBudgetCache();
  });

  it('addSpend increments daily and monthly spend', async () => {
    const before = checkBudget('test-model', tmp);
    assert.strictEqual(before.spentUsd, 0);

    await addSpend('test-model', 3.00, tmp);

    const after = checkBudget('test-model', tmp);
    assert.strictEqual(after.spentUsd, 3.00);
  });

  it('addSpend accumulates across calls', async () => {
    await addSpend('test-model', 2.00, tmp);

    const after = checkBudget('test-model', tmp);
    assert.strictEqual(after.spentUsd, 5.00);
  });

  it('should block when budget exceeded', async () => {
    await addSpend('test-model', 10.00, tmp);

    const check = checkBudget('test-model', tmp);
    assert.strictEqual(check.allowed, false);
  });
});

describe('reserve/release/extra-spend/status (fresh state per test)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-budget-test2-'));

  before(() => {
    const budgetYaml = [
      'global:',
      '  daily: 10',
      '  monthly: 100',
      'models:',
      '  test-model:',
      '    daily: 5',
      '    monthly: 50',
      'thresholds:',
      '  warn: 80',
      '  block: 100',
      'stateFile: .budget-test-state.json',
    ].join('\n');
    fs.writeFileSync(path.join(tmp, 'budget.yaml'), budgetYaml);
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    resetBudgetCache();
  });

  it('reserveBudget blocks when projected spend crosses the block threshold', () => {
    loadBudgetConfig(path.join(tmp, 'budget.yaml'));
    const r = reserveBudget('test-model', 100, tmp);
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason);
  });

  it('reserveBudget allows within limits and releaseReservation clears it', () => {
    resetBudgetCache();
    loadBudgetConfig(path.join(tmp, 'budget.yaml'));
    const reserved = reserveBudget('test-model', 1.5, tmp);
    assert.strictEqual(reserved.ok, true);
    // 1.5 + 4 = 5.5 > daily limit 5 (block threshold 100%) — denied.
    const blocked = reserveBudget('test-model', 4, tmp);
    assert.strictEqual(blocked.ok, false);
    // Releasing the exact reserved amount frees capacity.
    // (actualCost 0 keeps the fire-and-forget addSpend from leaking state
    // across tests.)
    releaseReservation('test-model', 1.5, 0, tmp);
    const again = reserveBudget('test-model', 4, tmp);
    assert.strictEqual(again.ok, true);
    releaseReservation('test-model', 4, 0, tmp);
  });

  it('checkBudget includes extraSpendUsd (current-run spend not yet in ledger)', () => {
    resetBudgetCache();
    loadBudgetConfig(path.join(tmp, 'budget.yaml'));
    const check = checkBudget('test-model', tmp, false, undefined, 4.5);
    assert.strictEqual(check.spentUsd, 4.5);
    const over = checkBudget('test-model', tmp, false, undefined, 6.0);
    assert.strictEqual(over.allowed, false);
  });

  it('getBudgetStatus reports configured limits and recorded spend', async () => {
    resetBudgetCache();
    loadBudgetConfig(path.join(tmp, 'budget.yaml'));
    await addSpend('test-model', 2.5, tmp);
    const status = getBudgetStatus(tmp);
    assert.strictEqual(status.global.daily.limit, 10);
    assert.strictEqual(status.models['test-model']?.daily.limit, 5);
    assert.strictEqual(status.global.daily.spent, 2.5);
  });
});
