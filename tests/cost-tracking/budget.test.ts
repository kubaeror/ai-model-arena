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
  mutateBudgetState,
  tryAcquireLock,
  releaseLock,
  lockAcquireTimeoutMs,
  lockStaleMs,
  DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
  DEFAULT_LOCK_STALE_MS,
} from '../../src/cost-tracking/budget.js';
import type { Logger } from '../../src/types.js';

const CONFIG = `
global:
  daily: 10
stateFile: outputs/.budget-state.json
`;

const LOCK_FILE = '.budget.lock';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Files a rename-verify-restore left behind (`.budget.lock.stale.<pid>.<ts>` / `.release.`). */
function lockSideFiles(rootDir: string): string[] {
  return fs.readdirSync(rootDir).filter((name) => /\.(stale|release)\./.test(name));
}

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

test('expired reservations no longer count against the budget', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  const today = new Date().toISOString().slice(0, 10);
  try {
    writeState(statePath, {
      models: {},
      reservations: { 'gpt-4o': [{ amount: 6, dailyKey: today, expiresAt: Date.now() - 1000 }] },
    });
    loadBudgetConfig(configPath);
    // 6 (expired reservation) + 5 = 11 > 10 limit — but the reservation is stale
    const result = reserveBudget('gpt-4o', 5, rootDir);
    assert.equal(result.ok, true);
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('live reservations still count against the budget', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  const today = new Date().toISOString().slice(0, 10);
  try {
    writeState(statePath, {
      models: {},
      reservations: { 'gpt-4o': [{ amount: 6, dailyKey: today, expiresAt: Date.now() + 60_000 }] },
    });
    loadBudgetConfig(configPath);
    const result = reserveBudget('gpt-4o', 5, rootDir);
    assert.equal(result.ok, false);
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

test('checkBudget re-reads the state file instead of serving a cached snapshot', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  try {
    loadBudgetConfig(configPath);
    assert.equal(checkBudget('gpt-4o', rootDir).allowed, true, 'no state file yet');
    writeState(statePath); // another process records gpt-4o daily spend = 15 (limit 10)
    const result = checkBudget('gpt-4o', rootDir);
    assert.equal(result.allowed, false, 'fresh read must see the other process spend');
    assert.equal(result.percentUsed, 150);
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('addSpend merges spend written by another process after our first read', async () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  const dayKey = new Date().toISOString().slice(0, 10);
  try {
    loadBudgetConfig(configPath);
    await addSpend('gpt-4o', 1, rootDir); // this process caches its own state

    // Another process reads the current file, adds its own spend, writes back.
    const other = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    other.global.daily[dayKey] = 5;
    other.models.claude = { daily: { [dayKey]: 5 }, monthly: {} };
    fs.writeFileSync(statePath, JSON.stringify(other, null, 2));

    await addSpend('gpt-4o', 1, rootDir);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.models.claude?.daily[dayKey], 5, "another process's model spend survives");
    assert.equal(persisted.global.daily[dayKey], 6, 'global spend includes both processes');
    assert.equal(persisted.models['gpt-4o']?.daily[dayKey], 2, 'our spend is added on top');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reserveBudget merges reservations written by another process after our first read', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  const dayKey = new Date().toISOString().slice(0, 10);
  try {
    writeState(statePath, { models: {} });
    loadBudgetConfig(configPath);
    assert.equal(reserveBudget('gpt-4o', 2, rootDir).ok, true);

    // Another process appends its own reservation to the shared file.
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.reservations = state.reservations ?? {};
    state.reservations.claude = [{ amount: 2, dailyKey: dayKey, expiresAt: Date.now() + 60_000 }];
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    assert.equal(reserveBudget('gpt-4o', 2, rootDir).ok, true);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.reservations.claude?.length, 1, "another process's reservation survives");
    assert.equal(persisted.reservations['gpt-4o']?.length, 2, 'both gpt-4o reservations are persisted');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('simulated second process keeps the first process spend while recording its own', async () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  const dayKey = new Date().toISOString().slice(0, 10);
  try {
    loadBudgetConfig(configPath);
    await addSpend('gpt-4o', 1, rootDir);

    resetBudgetCache(); // second process starts with fresh module state
    loadBudgetConfig(configPath);
    await addSpend('claude', 2, rootDir);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.global.daily[dayKey], 3, 'both processes counted in the global ledger');
    assert.equal(persisted.models['gpt-4o']?.daily[dayKey], 1);
    assert.equal(persisted.models.claude?.daily[dayKey], 2);
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a mutation waits for a fresh lock held by another process', async () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  const dayKey = new Date().toISOString().slice(0, 10);
  const lockPath = path.join(rootDir, LOCK_FILE);
  try {
    loadBudgetConfig(configPath);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, createdAt: Date.now() }));
    const pending = addSpend('gpt-4o', 1, rootDir);
    await sleep(150);
    assert.equal(fs.existsSync(statePath), false, 'mutation must not write while the lock is held');
    fs.rmSync(lockPath, { force: true });
    await pending;
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.models['gpt-4o'].daily[dayKey], 1);
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a stale lock is broken so an async mutation can proceed', async () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  const dayKey = new Date().toISOString().slice(0, 10);
  const lockPath = path.join(rootDir, LOCK_FILE);
  try {
    loadBudgetConfig(configPath);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, createdAt: Date.now() - 10 * 60 * 1000 }));
    await addSpend('gpt-4o', 1, rootDir);
    assert.equal(fs.existsSync(lockPath), false, 'stale lock is gone after the mutation');
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.models['gpt-4o'].daily[dayKey], 1);
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a stale lock is broken so a synchronous reservation can proceed', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  const lockPath = path.join(rootDir, LOCK_FILE);
  try {
    writeState(statePath, { models: {} });
    loadBudgetConfig(configPath);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, createdAt: Date.now() - 10 * 60 * 1000 }));
    assert.equal(reserveBudget('gpt-4o', 2, rootDir).ok, true);
    assert.equal(fs.existsSync(lockPath), false, 'stale lock is gone after the reservation');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('interleaved async spend and sync reserve/release keep every update', async () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  const dayKey = new Date().toISOString().slice(0, 10);
  try {
    writeState(statePath, { models: {} });
    loadBudgetConfig(configPath);

    const spend = addSpend('gpt-4o', 1, rootDir);
    assert.equal(reserveBudget('gpt-4o', 2, rootDir).ok, true);
    await spend;
    releaseReservation('gpt-4o', 2, 0, rootDir);
    await Promise.all([addSpend('claude', 3, rootDir), addSpend('gpt-4o', 1, rootDir)]);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.global.daily[dayKey], 5, 'all spend updates are counted');
    assert.equal(persisted.models['gpt-4o'].daily[dayKey], 2);
    assert.equal(persisted.models.claude.daily[dayKey], 3);
    assert.equal(persisted.reservations?.['gpt-4o']?.length ?? 0, 0, 'released reservation is gone');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an old holder release never deletes a lock a new holder acquired after a stale break', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath } = setup();
  const lockPath = path.join(rootDir, LOCK_FILE);
  try {
    loadBudgetConfig(configPath);
    // The stalled old holder's lock: stale timestamp, so a new holder may break it.
    const oldToken = 'old-holder-token';
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 4242, createdAt: Date.now() - 10 * 60 * 1000, token: oldToken,
    }));

    const newToken = tryAcquireLock(rootDir) ?? tryAcquireLock(rootDir);
    assert.ok(newToken, 'the new holder breaks the stale lock and acquires');

    // The old holder resumes after the stale break; its release must not unlink
    // the new holder's lock (owner token mismatch).
    releaseLock(rootDir, oldToken);
    assert.equal(fs.existsSync(lockPath), true, 'old holder release must not delete the new lock');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, newToken, 'new holder still owns the lock');

    releaseLock(rootDir, newToken);
    assert.equal(fs.existsSync(lockPath), false, 'the owner release removes its own lock');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a stale break aborts and restores the lock when a different token appears before the rename', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath } = setup();
  const lockPath = path.join(rootDir, LOCK_FILE);
  const observedToken = 'stale-observed-token';
  const replacementToken = 'fresh-replacement-token';
  try {
    loadBudgetConfig(configPath);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 4242, createdAt: Date.now() - 10 * 60 * 1000, token: observedToken,
    }));

    // A concurrent process replaces the lock between our staleness read and our
    // rename. The break must detect the mismatch, restore the file, and give up.
    const token = tryAcquireLock(rootDir, undefined, {
      onBeforeRename: () => {
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: 5252, createdAt: Date.now(), token: replacementToken,
        }));
      },
    });

    assert.equal(token, null, 'the break aborts instead of deleting the replacement');
    assert.equal(fs.existsSync(lockPath), true, 'the replacement lock is restored');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, replacementToken,
      "the replacement holder's token survives");
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a stale break still succeeds when the observed token matches at break time', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath } = setup();
  const lockPath = path.join(rootDir, LOCK_FILE);
  const observedToken = 'still-stale-token';
  try {
    loadBudgetConfig(configPath);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 4242, createdAt: Date.now() - 10 * 60 * 1000, token: observedToken,
    }));

    assert.equal(tryAcquireLock(rootDir), null, 'the matching stale lock is broken (caller retries)');
    assert.equal(fs.existsSync(lockPath), false, 'the verified stale lock file is gone');

    const token = tryAcquireLock(rootDir);
    assert.ok(token, 'the next attempt acquires the now-free lock');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, token, 'new holder owns the lock');
    releaseLock(rootDir, token!);
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('releaseLock with a stale token does not delete a newer holder lock (verified unlink)', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath } = setup();
  const lockPath = path.join(rootDir, LOCK_FILE);
  try {
    loadBudgetConfig(configPath);
    const newToken = 'new-holder-token';
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 5252, createdAt: Date.now(), token: newToken,
    }));

    releaseLock(rootDir, 'stale-old-token');

    assert.equal(fs.existsSync(lockPath), true, "the newer holder's lock survives a stale release");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, newToken, 'newer token is untouched');
    releaseLock(rootDir, newToken);
    assert.equal(fs.existsSync(lockPath), false, 'the actual owner can still release');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('releaseLock restores the lock when its token changes between read and rename', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath } = setup();
  const lockPath = path.join(rootDir, LOCK_FILE);
  const newToken = 'fresh-newer-token';
  try {
    loadBudgetConfig(configPath);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 5252, createdAt: Date.now(), token: 'our-token',
    }));

    // The file is ours at read time, but a stale-break plus a new acquisition
    // lands just before our rename: the rename grabs the new holder's file.
    releaseLock(rootDir, 'our-token', {
      onBeforeRename: () => {
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: 6363, createdAt: Date.now(), token: newToken,
        }));
      },
    });

    assert.equal(fs.existsSync(lockPath), true, 'the newer lock is restored, not deleted');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, newToken, 'newer holder still owns the lock');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a break mismatch with a free lock path restores the lock and removes the side file', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath } = setup();
  const lockPath = path.join(rootDir, LOCK_FILE);
  const observedToken = 'stale-observed-token';
  const replacementToken = 'fresh-replacement-token';
  try {
    loadBudgetConfig(configPath);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 4242, createdAt: Date.now() - 10 * 60 * 1000, token: observedToken,
    }));

    const token = tryAcquireLock(rootDir, undefined, {
      onBeforeRename: () => {
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: 5252, createdAt: Date.now(), token: replacementToken,
        }));
      },
    });

    assert.equal(token, null, 'the mismatched break abandons without acquiring');
    assert.equal(fs.existsSync(lockPath), true, 'the replacement is restored when the path is free');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, replacementToken);
    assert.deepEqual(lockSideFiles(rootDir), [], 'no .stale side file remains');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a break mismatch with an occupied lock path keeps the newer lock and drops the side file', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath } = setup();
  const lockPath = path.join(rootDir, LOCK_FILE);
  const observedToken = 'stale-observed-token';
  const replacementToken = 'fresh-replacement-token';
  const thirdToken = 'third-holder-token';
  try {
    loadBudgetConfig(configPath);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 4242, createdAt: Date.now() - 10 * 60 * 1000, token: observedToken,
    }));

    // The rename grabs a replacement written before it; before the verify, a
    // third process acquires a fresh lock at the now-free path. The mismatch
    // restore must not clobber that third lock.
    const token = tryAcquireLock(rootDir, undefined, {
      onBeforeRename: () => {
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: 5252, createdAt: Date.now(), token: replacementToken,
        }));
      },
      onAfterRenameBeforeVerify: () => {
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: 6363, createdAt: Date.now(), token: thirdToken,
        }));
      },
    });

    assert.equal(token, null, 'the mismatched break abandons without acquiring');
    assert.equal(fs.existsSync(lockPath), true, 'the newer holder lock is not removed');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, thirdToken,
      "the third holder's lock content is unchanged");
    assert.deepEqual(lockSideFiles(rootDir), [], 'the .stale side file is cleaned up');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a release mismatch with a free lock path restores the lock and removes the side file', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath } = setup();
  const lockPath = path.join(rootDir, LOCK_FILE);
  const replacementToken = 'fresh-newer-token';
  try {
    loadBudgetConfig(configPath);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 5252, createdAt: Date.now(), token: 'our-token',
    }));

    releaseLock(rootDir, 'our-token', {
      onBeforeRename: () => {
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: 6363, createdAt: Date.now(), token: replacementToken,
        }));
      },
    });

    assert.equal(fs.existsSync(lockPath), true, 'the replacement is restored when the path is free');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, replacementToken);
    assert.deepEqual(lockSideFiles(rootDir), [], 'no .release side file remains');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a release mismatch with an occupied lock path keeps the newer lock and drops the side file', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath } = setup();
  const lockPath = path.join(rootDir, LOCK_FILE);
  const replacementToken = 'fresh-newer-token';
  const thirdToken = 'third-holder-token';
  try {
    loadBudgetConfig(configPath);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 5252, createdAt: Date.now(), token: 'our-token',
    }));

    // The rename grabs a replacement written before it; before the verify, a
    // third process acquires a fresh lock at the now-free path. The mismatch
    // restore must not clobber that third lock.
    releaseLock(rootDir, 'our-token', {
      onBeforeRename: () => {
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: 6363, createdAt: Date.now(), token: replacementToken,
        }));
      },
      onAfterRenameBeforeVerify: () => {
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: 7373, createdAt: Date.now(), token: thirdToken,
        }));
      },
    });

    assert.equal(fs.existsSync(lockPath), true, 'the newer holder lock is not removed');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, thirdToken,
      "the third holder's lock content is unchanged");
    assert.deepEqual(lockSideFiles(rootDir), [], 'the .release side file is cleaned up');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('verified break/release successes leave no .stale/.release side files', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath } = setup();
  const lockPath = path.join(rootDir, LOCK_FILE);
  try {
    loadBudgetConfig(configPath);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 4242, createdAt: Date.now() - 10 * 60 * 1000, token: 'aged-token',
    }));
    assert.equal(tryAcquireLock(rootDir), null, 'the verified stale lock is broken');
    assert.deepEqual(lockSideFiles(rootDir), [], 'no .stale file after a verified break');

    const token = tryAcquireLock(rootDir);
    assert.ok(token, 'the next attempt acquires the lock');
    releaseLock(rootDir, token!);
    assert.equal(fs.existsSync(lockPath), false, 'the owner release removes its lock');
    assert.deepEqual(lockSideFiles(rootDir), [], 'no .release file after a verified release');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('lock file removal failures still clean up the side file via the catch path', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath } = setup();
  const lockPath = path.join(rootDir, LOCK_FILE);
  try {
    loadBudgetConfig(configPath);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 5252, createdAt: Date.now(), token: 'catch-path-token',
    }));

    // Force the post-rename verify to throw: the catch path must restore the
    // lock (path free) through the non-clobbering helper and drop the side file.
    const throwingHooks = {
      onAfterRenameBeforeVerify: () => {
        throw new Error('injected verify failure');
      },
    };
    releaseLock(rootDir, 'catch-path-token', throwingHooks);

    assert.equal(fs.existsSync(lockPath), true, 'the lock is restored by the catch path');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'catch-path-token');
    assert.deepEqual(lockSideFiles(rootDir), [], 'no .release side file after the catch path');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a stale window >= the acquire timeout is clamped to half the timeout with one warning', () => {
  resetBudgetCache();
  const prevTimeout = process.env.BUDGET_LOCK_TIMEOUT_MS;
  const prevStale = process.env.BUDGET_LOCK_STALE_MS;
  try {
    process.env.BUDGET_LOCK_TIMEOUT_MS = '10000';
    process.env.BUDGET_LOCK_STALE_MS = '10000';
    const warnings: string[] = [];
    const logger: Logger = {
      info: () => {}, warn: (msg) => { warnings.push(msg); }, error: () => {}, debug: () => {},
      child: () => logger,
    };

    assert.equal(lockStaleMs(logger), 5_000, 'stale is clamped to half the timeout');
    assert.equal(warnings.length, 1, 'the clamp warns once');
    lockStaleMs(logger);
    assert.equal(warnings.length, 1, 'repeat calls do not spam the warning');
    assert.match(warnings[0] ?? '', /BUDGET_LOCK_STALE_MS/);
  } finally {
    if (prevTimeout === undefined) delete process.env.BUDGET_LOCK_TIMEOUT_MS;
    else process.env.BUDGET_LOCK_TIMEOUT_MS = prevTimeout;
    if (prevStale === undefined) delete process.env.BUDGET_LOCK_STALE_MS;
    else process.env.BUDGET_LOCK_STALE_MS = prevStale;
    resetBudgetCache();
  }
});

test('lock env overrides: valid integers are accepted', () => {
  const prevTimeout = process.env.BUDGET_LOCK_TIMEOUT_MS;
  const prevStale = process.env.BUDGET_LOCK_STALE_MS;
  try {
    delete process.env.BUDGET_LOCK_TIMEOUT_MS;
    delete process.env.BUDGET_LOCK_STALE_MS;
    assert.equal(lockAcquireTimeoutMs(), DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS, 'timeout default');
    assert.equal(lockStaleMs(), DEFAULT_LOCK_STALE_MS, 'stale default');
    assert.equal(DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS, 10_000);
    assert.equal(DEFAULT_LOCK_STALE_MS, 5_000);

    process.env.BUDGET_LOCK_TIMEOUT_MS = '25000';
    process.env.BUDGET_LOCK_STALE_MS = '7500';
    assert.equal(lockAcquireTimeoutMs(), 25_000);
    assert.equal(lockStaleMs(), 7_500);
  } finally {
    if (prevTimeout === undefined) delete process.env.BUDGET_LOCK_TIMEOUT_MS;
    else process.env.BUDGET_LOCK_TIMEOUT_MS = prevTimeout;
    if (prevStale === undefined) delete process.env.BUDGET_LOCK_STALE_MS;
    else process.env.BUDGET_LOCK_STALE_MS = prevStale;
  }
});

test('lock env overrides: 0, negative, NaN and non-numeric values fall back to defaults', () => {
  const prevTimeout = process.env.BUDGET_LOCK_TIMEOUT_MS;
  const prevStale = process.env.BUDGET_LOCK_STALE_MS;
  try {
    for (const bad of ['0', '-1', 'NaN', '12abc', 'Infinity', '1.5', '']) {
      process.env.BUDGET_LOCK_TIMEOUT_MS = bad;
      process.env.BUDGET_LOCK_STALE_MS = bad;
      assert.equal(lockAcquireTimeoutMs(), DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS, `timeout rejects ${bad || '<empty>'}`);
      assert.equal(lockStaleMs(), DEFAULT_LOCK_STALE_MS, `stale rejects ${bad || '<empty>'}`);
    }
  } finally {
    if (prevTimeout === undefined) delete process.env.BUDGET_LOCK_TIMEOUT_MS;
    else process.env.BUDGET_LOCK_TIMEOUT_MS = prevTimeout;
    if (prevStale === undefined) delete process.env.BUDGET_LOCK_STALE_MS;
    else process.env.BUDGET_LOCK_STALE_MS = prevStale;
  }
});

test('BUDGET_LOCK_STALE_MS shortens the stale window used when breaking locks', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath } = setup();
  const lockPath = path.join(rootDir, LOCK_FILE);
  const prevStale = process.env.BUDGET_LOCK_STALE_MS;
  try {
    process.env.BUDGET_LOCK_STALE_MS = '1';
    loadBudgetConfig(configPath);
    // Age the lock just past the custom 1ms window but not the default 5s.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, createdAt: Date.now() - 50, token: 'aged' }));
    assert.equal(tryAcquireLock(rootDir), null, 'the shortened window breaks a 50ms-old lock');
    assert.equal(fs.existsSync(lockPath), false, 'the stale lock is removed');
    assert.ok(tryAcquireLock(rootDir), 'the next attempt acquires the lock');
  } finally {
    if (prevStale === undefined) delete process.env.BUDGET_LOCK_STALE_MS;
    else process.env.BUDGET_LOCK_STALE_MS = prevStale;
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mutateBudgetState serializes concurrent read-modify-write mutations', async () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  const dayKey = new Date().toISOString().slice(0, 10);
  try {
    loadBudgetConfig(configPath);
    const bump = () => mutateBudgetState(rootDir, (state) => {
      state.global.daily[dayKey] = (state.global.daily[dayKey] ?? 0) + 1;
    });
    await Promise.all([bump(), bump(), bump()]);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.global.daily[dayKey], 3, 'every serialized mutation is applied');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
