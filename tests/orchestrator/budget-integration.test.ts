import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadBudgetConfig, addSpend, checkBudget, resetBudgetCache } from '../../src/cost-tracking/budget.js';

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

  it('addSpend increments daily and monthly spend', () => {
    const before = checkBudget('test-model', tmp);
    assert.strictEqual(before.spentUsd, 0);

    addSpend('test-model', 3.00, tmp);

    const after = checkBudget('test-model', tmp);
    assert.strictEqual(after.spentUsd, 3.00);
  });

  it('addSpend accumulates across calls', () => {
    addSpend('test-model', 2.00, tmp);

    const after = checkBudget('test-model', tmp);
    assert.strictEqual(after.spentUsd, 5.00);
  });

  it('should block when budget exceeded', () => {
    addSpend('test-model', 10.00, tmp);

    const check = checkBudget('test-model', tmp);
    assert.strictEqual(check.allowed, false);
  });
});
