import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Logger } from '../types.js';
import { loadYamlConfigSync, clearConfigCache } from '../config-loader.js';
import { outputRoot } from '../paths.js';
import { BudgetConfigSchema, type BudgetConfig, type BudgetState, type BudgetCheckResult } from './types.js';
import { budgetPercent } from '../observability/metrics.js';

let budgetConfig: BudgetConfig | null = null;
// Async mutations are serialized within the process; sync mutations are atomic
// on the event loop. Both paths take the cross-process lockfile.
let mutationQueue: Promise<unknown> = Promise.resolve();
let tmpCounter = 0;
let staleClampWarned = false;

const DAY_KEY = () => new Date().toISOString().slice(0, 10);
const MONTH_KEY = () => new Date().toISOString().slice(0, 7);

/** Reservations older than this are considered leaked (crashed runs) and pruned. */
const RESERVATION_TTL_MS = 4 * 60 * 60 * 1000;

/** Object.prototype keys that a model name must never write through. */
const LEDGER_RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeLedgerModel(modelName: string): boolean {
  return !LEDGER_RESERVED_KEYS.has(modelName);
}

const LOCK_FILE = '.budget.lock';
/** Give up on a lock only after the stale timeout has had a chance to break it. */
export const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
/** Locks older than this belong to a crashed holder and can be broken.
 *  Must stay below the acquire timeout; values >= it are clamped by lockStaleMs(). */
export const DEFAULT_LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 25;

/**
 * Read a positive-integer lock env override, falling back to `fallback` for
 * missing/garbage values ('0', negatives, NaN, decimals, trailing junk).
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  // Strict digits-only: Number()/parseInt would accept '1e3', ' 12 ' or
  // '12abc' and silently mis-size the stall window.
  if (raw !== undefined && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

export function lockAcquireTimeoutMs(): number {
  return positiveIntEnv('BUDGET_LOCK_TIMEOUT_MS', DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS);
}

/**
 * Stale window used to break crashed holders. Clamped to half the acquire
 * timeout when the override is >= the timeout: otherwise a waiter always times
 * out before any lock can go stale, so a crashed holder would stall every
 * caller forever. The clamp is warned once per process.
 */
export function lockStaleMs(logger?: Logger): number {
  const stale = positiveIntEnv('BUDGET_LOCK_STALE_MS', DEFAULT_LOCK_STALE_MS);
  const timeout = lockAcquireTimeoutMs();
  if (stale < timeout) return stale;

  const clamped = Math.max(1, Math.floor(timeout / 2));
  if (!staleClampWarned) {
    staleClampWarned = true;
    logger?.warn('BUDGET_LOCK_STALE_MS >= BUDGET_LOCK_TIMEOUT_MS; clamping the stale window to half the acquire timeout', {
      staleMs: stale,
      timeoutMs: timeout,
      effectiveStaleMs: clamped,
    });
  }
  return clamped;
}

/**
 * Test seam: the hooks run inside the read→rename→verify windows that cannot
 * be interleaved on a single-threaded event loop, letting tests inject a
 * concurrent replacement deterministically.
 */
export interface LockRaceHooks {
  onBeforeRename?: () => void;
  onAfterRenameBeforeVerify?: () => void;
}

/**
 * Restore a lock file that was renamed aside for verification, without
 * clobbering a newer holder that claimed `lockPath` in the meantime: link()
 * fails with EEXIST when the path is occupied, in which case the newer lock
 * wins and the renamed file is dropped. The side file is always unlinked, so
 * neither outcome can leave an orphan behind.
 */
function restoreSideFile(sidePath: string, lockPath: string): void {
  if (!fs.existsSync(sidePath)) return;
  try {
    fs.linkSync(sidePath, lockPath);
  } catch {
    // EEXIST (or any other failure): leave the current lock at the path alone.
  } finally {
    try {
      fs.rmSync(sidePath, { force: true });
    } catch {
      // Best effort; a leftover side file is diagnostic clutter, not a lock.
    }
  }
}

function getEmptyState(): BudgetState {
  return {
    global: { daily: {}, monthly: {} },
    models: {},
    reservations: {},
    lastReset: new Date().toISOString(),
  };
}

export function loadBudgetConfig(configPath: string, logger?: Logger): BudgetConfig {
  if (budgetConfig) return budgetConfig;

  budgetConfig = loadYamlConfigSync({
    filePath: configPath,
    schema: BudgetConfigSchema,
    fallback: BudgetConfigSchema.parse({}),
    cache: true,
    logger,
    missingMessage: `Budget config not found at ${path.resolve(configPath)}, budget checks disabled`,
  });
  return budgetConfig;
}

function getStatePath(config: BudgetConfig, rootDir: string): string {
  // Resolve through budgetStateRoot so every process and caller (CLI, runner,
  // dashboard) points at the same ledger when OUTPUT_ROOT is set.
  return path.join(budgetStateRoot(rootDir), config.stateFile);
}

/**
 * Base directory for the budget state file. Follows OUTPUT_ROOT when set so
 * runners, the dashboard and the orchestrator all read/write the same ledger
 * in containerized deployments; otherwise stays under the base root.
 */
export function budgetStateRoot(baseRoot: string): string {
  return process.env.OUTPUT_ROOT ? outputRoot() : baseRoot;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Fresh read of the ledger file — never cached, so other processes' writes are seen. */
function readBudgetStateFile(statePath: string, logger?: Logger): BudgetState {
  if (!fs.existsSync(statePath)) return getEmptyState();

  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as BudgetState;
  } catch {
    logger?.warn('Failed to parse budget state, resetting', { path: statePath });
    return getEmptyState();
  }
}

function writeBudgetStateFile(statePath: string, state: BudgetState, logger?: Logger): void {
  ensureDir(path.dirname(statePath));
  // Atomic write: temp file + rename (rename is atomic on POSIX).
  const tmpPath = `${statePath}.tmp.${process.pid}.${tmpCounter++}`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, statePath);
  logger?.debug('Budget state saved', { path: statePath });
}

function budgetLockPath(rootDir: string): string {
  // Same resolved root as the ledger, so different callers never lock
  // different files for the same state.
  return path.join(budgetStateRoot(rootDir), LOCK_FILE);
}

function lockTokenAt(lockPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { token?: unknown };
    return typeof parsed.token === 'string' ? parsed.token : null;
  } catch {
    return null;
  }
}

/**
 * Try to create the lockfile, breaking a stale one as a side effect. Returns
 * the owner token written into the lock on success, null when another live
 * holder has it. The token lets a stalled holder detect that its lock was
 * stale-broken and replaced before it resumes: only the current owner may
 * remove the file.
 *
 * Stale breaks are rename-then-verify: the lock is renamed to a unique path,
 * the renamed file is re-read, and the break only completes when its token
 * still matches the one observed before the rename. A mismatch means another
 * process replaced the lock in between, so the file is restored via a
 * non-overwriting link() and the break is abandoned; when the path is occupied
 * by a newer lock the older file is dropped instead of clobbering it.
 *
 * Bounded guarantee: a mismatched break never unlinks or rewrites whatever
 * currently occupies `lockPath`. Because this function only ever returns a
 * token it wrote itself with O_EXCL, restoring a file cannot mint a second
 * holder; strict mutual exclusion for tokens already handed out still relies
 * on the token + rename protocol (a holder whose token fails verification
 * abandons without modifying the path).
 */
export function tryAcquireLock(rootDir: string, logger?: Logger, hooks?: LockRaceHooks): string | null {
  const lockPath = budgetLockPath(rootDir);
  ensureDir(path.dirname(lockPath));
  const token = crypto.randomBytes(16).toString('hex');

  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }), { flag: 'wx' });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    let observedToken: string | null = null;
    let createdAt: number | undefined;
    try {
      const parsed = JSON.parse(raw) as { createdAt?: number; token?: unknown };
      createdAt = parsed.createdAt;
      if (typeof parsed.token === 'string') observedToken = parsed.token;
    } catch {
      // Unparsable lock content — fall back to the file mtime.
    }
    const age = Date.now() - (typeof createdAt === 'number' ? createdAt : fs.statSync(lockPath).mtimeMs);
    if (age > lockStaleMs(logger)) {
      const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}`;
      try {
        hooks?.onBeforeRename?.();
        // Rename before deleting so a lock another process just re-created is never removed.
        fs.renameSync(lockPath, stalePath);
        hooks?.onAfterRenameBeforeVerify?.();
        // The rename may have grabbed a replacement written after our staleness
        // read: only a token that still matches the observed one is really stale.
        if (lockTokenAt(stalePath) !== observedToken) {
          restoreSideFile(stalePath, lockPath);
          return null;
        }
        fs.rmSync(stalePath, { force: true });
        logger?.warn('Broke stale budget lock', { path: lockPath, ageMs: age });
      } catch {
        // A failed break (e.g. the lock vanished) must not orphan the renamed file.
        restoreSideFile(stalePath, lockPath);
      }
    }
  } catch {
    // Lock disappeared between attempts; retry.
  }
  return null;
}

/**
 * Remove the lockfile only when it still carries `token`. Rename-verify-unlink:
 * the lock is renamed to a unique path and the renamed file is re-read; it is
 * only unlinked when its token still matches. Read-verify-unlink alone leaves a
 * read→unlink window where a stale break plus a new acquisition could hand us a
 * fresh holder's lock, which this closes. A mismatch restores the file only
 * through a non-overwriting link(), so a newer lock that claimed the path in
 * the meantime keeps its content; the renamed file is dropped in that case.
 */
export function releaseLock(rootDir: string, token: string, hooks?: LockRaceHooks): void {
  const lockPath = budgetLockPath(rootDir);
  if (lockTokenAt(lockPath) !== token) return;

  const releasePath = `${lockPath}.release.${process.pid}.${Date.now()}`;
  try {
    hooks?.onBeforeRename?.();
    fs.renameSync(lockPath, releasePath);
    hooks?.onAfterRenameBeforeVerify?.();
    if (lockTokenAt(releasePath) !== token) {
      restoreSideFile(releasePath, lockPath);
      return;
    }
    fs.rmSync(releasePath, { force: true });
  } catch {
    // Best effort: a failed rename/unlink must not fail an already-written
    // mutation, but it must not orphan the renamed file either.
    restoreSideFile(releasePath, lockPath);
  }
}

const lockSleep = new Int32Array(new SharedArrayBuffer(4));

/** Synchronous lock wait for the sync APIs, which cannot await. */
function acquireLockSync(rootDir: string, logger?: Logger): () => void {
  const deadline = Date.now() + lockAcquireTimeoutMs();
  for (;;) {
    const token = tryAcquireLock(rootDir, logger);
    if (token !== null) return () => releaseLock(rootDir, token);
    if (Date.now() >= deadline) throw new Error(`Timed out acquiring budget lock at ${budgetLockPath(rootDir)}`);
    Atomics.wait(lockSleep, 0, 0, LOCK_RETRY_MS);
  }
}

async function acquireLock(rootDir: string, logger?: Logger): Promise<() => void> {
  const deadline = Date.now() + lockAcquireTimeoutMs();
  for (;;) {
    const token = tryAcquireLock(rootDir, logger);
    if (token !== null) return () => releaseLock(rootDir, token);
    if (Date.now() >= deadline) throw new Error(`Timed out acquiring budget lock at ${budgetLockPath(rootDir)}`);
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

function withBudgetLockSync<T>(rootDir: string, logger: Logger | undefined, fn: () => T): T {
  const release = acquireLockSync(rootDir, logger);
  try {
    return fn();
  } finally {
    release();
  }
}

async function withBudgetLock<T>(rootDir: string, logger: Logger | undefined, fn: () => T): Promise<T> {
  const release = await acquireLock(rootDir, logger);
  try {
    return fn();
  } finally {
    release();
  }
}

/**
 * Read-modify-write the shared budget file under a cross-process lock.
 * `fn` must be synchronous: the lock is held until it returns, and awaiting
 * inside it would let a synchronous mutation deadlock on the same lock.
 */
export function mutateBudgetState<T>(
  rootDir: string,
  fn: (state: BudgetState) => T,
  logger?: Logger,
): Promise<T> {
  const config = budgetConfig;
  if (!config) return Promise.resolve(fn(getEmptyState()));

  const statePath = getStatePath(config, rootDir);
  const run = () => withBudgetLock(rootDir, logger, () => {
    const state = readBudgetStateFile(statePath, logger);
    const result = fn(state);
    writeBudgetStateFile(statePath, state, logger);
    return result;
  });
  const queued = mutationQueue.then(run, run);
  mutationQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

function applySpend(state: BudgetState, modelName: string, usd: number): void {
  const dayKey = DAY_KEY();
  const monthKey = MONTH_KEY();

  state.global.daily[dayKey] = (state.global.daily[dayKey] ?? 0) + usd;
  state.global.monthly[monthKey] = (state.global.monthly[monthKey] ?? 0) + usd;

  let modelEntry = state.models[modelName];
  if (!modelEntry) {
    modelEntry = { daily: {}, monthly: {} };
    Object.defineProperty(state.models, modelName, {
      value: modelEntry,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  modelEntry.daily[dayKey] = (modelEntry.daily[dayKey] ?? 0) + usd;
  modelEntry.monthly[monthKey] = (modelEntry.monthly[monthKey] ?? 0) + usd;
}

export function addSpend(modelName: string, usd: number, rootDir: string, logger?: Logger): Promise<void> {
  if (!budgetConfig) return Promise.resolve();

  if (!safeLedgerModel(modelName)) {
    logger?.warn('Ignoring spend for unsafe model name', { modelName });
    return Promise.resolve();
  }

  return mutateBudgetState(rootDir, (state) => {
    applySpend(state, modelName, usd);
  }, logger);
}

function todayReservedTotal(state: BudgetState, modelName: string): number {
  const today = DAY_KEY();
  let total = 0;
  for (const entry of state.reservations?.[modelName] ?? []) {
    if (entry.dailyKey !== today) continue;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) continue;
    total += entry.amount;
  }
  return total;
}

function removeReservationEntry(
  state: BudgetState,
  modelName: string,
  estimatedCostUsd: number,
  logger?: Logger,
): boolean {
  const entries = state.reservations?.[modelName];
  if (!entries || entries.length === 0) return false;

  const today = DAY_KEY();
  // Match the persisted entry by amount so out-of-order releases of different
  // amounts remove the right entry (reserve 2 then 5, release the 5 first).
  const idx = entries.findIndex((entry) => entry.dailyKey === today && entry.amount === estimatedCostUsd);
  if (idx >= 0) {
    entries.splice(idx, 1);
    return true;
  }
  if (entries.some((entry) => entry.dailyKey === today)) {
    // A today entry exists but none matches: leave persisted entries untouched
    // rather than deleting the wrong one; reserve/release amounts are expected
    // to match.
    logger?.warn('No persisted reservation entry matches released amount; leaving persisted reservations untouched', {
      model: modelName,
      estimatedCost: estimatedCostUsd,
      today,
      persistedEntries: entries.length,
    });
  }
  return false;
}

/**
 * Reserve an estimated cost before dispatching a job.
 * Returns {ok: true} if the reservation is within budget limits, {ok: false} otherwise.
 * The reservation is persisted and must be released via releaseReservation().
 */
export function reserveBudget(
  modelName: string,
  estimatedCostUsd: number,
  rootDir: string,
  logger?: Logger,
): { ok: boolean; reason?: string } {
  if (!budgetConfig) return { ok: true };

  if (!safeLedgerModel(modelName)) {
    logger?.warn('Ignoring reservation for unsafe model name', { modelName });
    return { ok: true };
  }

  const config = budgetConfig;
  const statePath = getStatePath(config, rootDir);

  return withBudgetLockSync(rootDir, logger, () => {
    const state = readBudgetStateFile(statePath, logger);
    const modelLimits = config.models?.[modelName];
    const globalLimits = config.global;
    const thresholds = config.thresholds ?? { warn: 80, block: 100 };

    const spentDaily = getSpendToday(state, modelName);
    const spentMonthly = getSpendMonth(state, modelName);
    const limitDaily = modelLimits?.daily ?? globalLimits?.daily;
    const limitMonthly = modelLimits?.monthly ?? globalLimits?.monthly;

    const totalReserved = todayReservedTotal(state, modelName);

    if (limitDaily !== null && limitDaily !== undefined) {
      const projectedDaily = spentDaily + totalReserved + estimatedCostUsd;
      const percentDaily = (projectedDaily / limitDaily) * 100;
      if (percentDaily > thresholds.block) {
        return {
          ok: false,
          reason: `Budget reservation blocked for ${modelName}: projected daily spend $${projectedDaily.toFixed(2)} exceeds limit $${limitDaily} (${percentDaily.toFixed(0)}%)`,
        };
      }
    }
    if (limitMonthly !== null && limitMonthly !== undefined) {
      const projectedMonthly = spentMonthly + totalReserved + estimatedCostUsd;
      const percentMonthly = (projectedMonthly / limitMonthly) * 100;
      if (percentMonthly > thresholds.block) {
        return {
          ok: false,
          reason: `Budget reservation blocked for ${modelName}: projected monthly spend $${projectedMonthly.toFixed(2)} exceeds limit $${limitMonthly} (${percentMonthly.toFixed(0)}%)`,
        };
      }
    }

    if (!state.reservations) state.reservations = {};
    let modelReservations = state.reservations[modelName];
    if (!modelReservations) {
      modelReservations = [];
      Object.defineProperty(state.reservations, modelName, {
        value: modelReservations,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    modelReservations.push({ amount: estimatedCostUsd, dailyKey: DAY_KEY(), expiresAt: Date.now() + RESERVATION_TTL_MS });
    writeBudgetStateFile(statePath, state, logger);

    logger?.debug('Budget reserved', {
      model: modelName,
      estimatedCost: estimatedCostUsd,
      totalReserved: totalReserved + estimatedCostUsd,
      dailySpent: spentDaily,
      monthlySpent: spentMonthly,
    });

    return { ok: true };
  });
}

/**
 * Release a budget reservation and add the actual spend.
 * Must be called after job completion (success or failure).
 */
export function releaseReservation(
  modelName: string,
  estimatedCostUsd: number,
  actualCostUsd: number,
  rootDir: string,
  logger?: Logger,
): void {
  if (!budgetConfig || !safeLedgerModel(modelName)) return;

  const config = budgetConfig;
  const statePath = getStatePath(config, rootDir);

  withBudgetLockSync(rootDir, logger, () => {
    const state = readBudgetStateFile(statePath, logger);
    const removed = removeReservationEntry(state, modelName, estimatedCostUsd, logger);
    if (actualCostUsd > 0) applySpend(state, modelName, actualCostUsd);
    // Leave the file untouched when neither the reservation nor spend changed.
    if (removed || actualCostUsd > 0) writeBudgetStateFile(statePath, state, logger);

    logger?.debug('Budget reservation released', {
      model: modelName,
      estimatedCost: estimatedCostUsd,
      actualCost: actualCostUsd,
      remainingReserved: todayReservedTotal(state, modelName),
    });
  });
}

function getSpendToday(state: BudgetState, modelName?: string): number {
  const dayKey = DAY_KEY();
  if (modelName) {
    return state.models[modelName]?.daily[dayKey] ?? 0;
  }
  return state.global.daily[dayKey] ?? 0;
}

function getSpendMonth(state: BudgetState, modelName?: string): number {
  const monthKey = MONTH_KEY();
  if (modelName) {
    return state.models[modelName]?.monthly[monthKey] ?? 0;
  }
  return state.global.monthly[monthKey] ?? 0;
}

/**
 * Check budget for a model. `extraSpendUsd` lets callers include spend that is
 * not yet in the ledger (e.g. the current run's tokens, which are only added
 * to the state file at finalize time) so mid-run checks can trip on it.
 */
export function checkBudget(modelName: string, rootDir: string, force: boolean = false, logger?: Logger, extraSpendUsd: number = 0): BudgetCheckResult {
  if (!budgetConfig) {
    return { allowed: true, spentUsd: 0, limitUsd: null, percentUsed: 0 };
  }

  const config = budgetConfig;
  const state = readBudgetStateFile(getStatePath(config, rootDir), logger);

  const modelLimits = config.models?.[modelName];
  const globalLimits = config.global;
  const thresholds = config.thresholds ?? { warn: 80, block: 100 };

  const spentDaily = getSpendToday(state, modelName) + extraSpendUsd;
  const spentMonthly = getSpendMonth(state, modelName) + extraSpendUsd;

  const limitDaily = modelLimits?.daily ?? globalLimits?.daily;
  const limitMonthly = modelLimits?.monthly ?? globalLimits?.monthly;

  let percentDaily = 0;
  let percentMonthly = 0;

  if (limitDaily !== null && limitDaily !== undefined) {
    percentDaily = (spentDaily / limitDaily) * 100;
  }
  if (limitMonthly !== null && limitMonthly !== undefined) {
    percentMonthly = (spentMonthly / limitMonthly) * 100;
  }

  const effectiveLimit = limitDaily ?? limitMonthly ?? null;
  const effectiveSpent = limitDaily !== null && limitDaily !== undefined ? spentDaily : spentMonthly;
  const effectivePercent = limitDaily !== null && limitDaily !== undefined ? percentDaily : percentMonthly;

  budgetPercent.set({ model: modelName }, effectivePercent);

  if (force) {
    return { allowed: true, spentUsd: effectiveSpent, limitUsd: effectiveLimit, percentUsed: effectivePercent };
  }

  if (limitDaily !== null && limitDaily !== undefined && percentDaily >= thresholds.block) {
    return {
      allowed: false,
      reason: `Daily budget exceeded for ${modelName}: spent $${spentDaily.toFixed(2)} of $${limitDaily} (${percentDaily.toFixed(0)}%)`,
      spentUsd: spentDaily,
      limitUsd: limitDaily,
      percentUsed: percentDaily,
    };
  }

  if (limitMonthly !== null && limitMonthly !== undefined && percentMonthly >= thresholds.block) {
    return {
      allowed: false,
      reason: `Monthly budget exceeded for ${modelName}: spent $${spentMonthly.toFixed(2)} of $${limitMonthly} (${percentMonthly.toFixed(0)}%)`,
      spentUsd: spentMonthly,
      limitUsd: limitMonthly,
      percentUsed: percentMonthly,
    };
  }

  return { allowed: true, spentUsd: effectiveSpent, limitUsd: effectiveLimit, percentUsed: effectivePercent };
}

export function getBudgetStatus(rootDir: string, logger?: Logger): {
  global: { daily: { spent: number; limit: number | null }; monthly: { spent: number; limit: number | null } };
  models: Record<string, { daily: { spent: number; limit: number | null }; monthly: { spent: number; limit: number | null } }>;
} {
  if (!budgetConfig) {
    return {
      global: { daily: { spent: 0, limit: null }, monthly: { spent: 0, limit: null } },
      models: {},
    };
  }

  const config = budgetConfig;
  const state = readBudgetStateFile(getStatePath(config, rootDir), logger);

  const result = {
    global: {
      daily: { spent: getSpendToday(state), limit: config.global?.daily ?? null },
      monthly: { spent: getSpendMonth(state), limit: config.global?.monthly ?? null },
    },
    models: {} as Record<string, { daily: { spent: number; limit: number | null }; monthly: { spent: number; limit: number | null } }>,
  };

  const allModels = new Set(Object.keys(state.models));
  if (config.models) {
    for (const m of Object.keys(config.models)) allModels.add(m);
  }

  for (const modelName of allModels) {
    result.models[modelName] = {
      daily: { spent: getSpendToday(state, modelName), limit: config.models?.[modelName]?.daily ?? null },
      monthly: { spent: getSpendMonth(state, modelName), limit: config.models?.[modelName]?.monthly ?? null },
    };
  }

  return result;
}

/** Persist per-run reservations (runId -> model -> amount) in the budget state
 *  file so the releasing process — usually the runner, a different process
 *  from the one that called startRun — knows the exact amounts. */
export function recordRunReservations(
  runId: string,
  reservations: Array<{ model: string; estimated: number }>,
  rootDir: string,
  logger?: Logger,
): void {
  if (!budgetConfig) return;

  const config = budgetConfig;
  const statePath = getStatePath(config, rootDir);

  withBudgetLockSync(rootDir, logger, () => {
    const state = readBudgetStateFile(statePath, logger);
    state.runReservations = state.runReservations ?? {};
    const entry: Record<string, number> = {};
    for (const r of reservations) entry[r.model] = (entry[r.model] ?? 0) + r.estimated;
    state.runReservations[runId] = entry;
    writeBudgetStateFile(statePath, state, logger);
  });
}

/** Release a run's reservations against actual costs, reading the reserved
 *  amounts from the persisted state file (process-independent). */
export function releaseRunReservations(
  runId: string,
  entries: Array<{ model: string; result?: { costUsd?: number } | null }>,
  rootDir: string,
  logger?: Logger,
): void {
  if (!budgetConfig) return;

  const config = budgetConfig;
  const statePath = getStatePath(config, rootDir);

  withBudgetLockSync(rootDir, logger, () => {
    const state = readBudgetStateFile(statePath, logger);
    const reserved = state.runReservations?.[runId] ?? {};
    for (const entry of entries) {
      if (!safeLedgerModel(entry.model)) continue;
      const estimatedCostUsd = reserved[entry.model] ?? 0;
      const actualCostUsd = entry.result?.costUsd ?? 0;
      removeReservationEntry(state, entry.model, estimatedCostUsd, logger);
      if (actualCostUsd > 0) applySpend(state, entry.model, actualCostUsd);
      logger?.debug('Budget reservation released', {
        model: entry.model,
        estimatedCost: estimatedCostUsd,
        actualCost: actualCostUsd,
        remainingReserved: todayReservedTotal(state, entry.model),
      });
    }
    if (state.runReservations) delete state.runReservations[runId];
    writeBudgetStateFile(statePath, state, logger);
  });
}

export function resetBudgetCache(): void {
  budgetConfig = null;
  mutationQueue = Promise.resolve();
  staleClampWarned = false;
  clearConfigCache();
}
