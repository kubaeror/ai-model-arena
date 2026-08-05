import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import type { Logger } from '../types.js';
import { BudgetConfigSchema, type BudgetConfig, type BudgetState, type BudgetCheckResult } from './types.js';

let budgetConfig: BudgetConfig | null = null;
let budgetState: BudgetState | null = null;
// Serialize addSpend calls to prevent concurrent read-modify-write races
let spendQueue: Promise<void> = Promise.resolve();

const DAY_KEY = () => new Date().toISOString().slice(0, 10);
const MONTH_KEY = () => new Date().toISOString().slice(0, 7);

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
  
  const resolvedPath = path.resolve(configPath);
  if (!fs.existsSync(resolvedPath)) {
    const fallback = BudgetConfigSchema.parse({});
    logger?.warn(`Budget config not found at ${resolvedPath}, budget checks disabled`);
    budgetConfig = fallback;
    return fallback;
  }
  
  const content = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = load(content);
  const validated = BudgetConfigSchema.parse(parsed);
  budgetConfig = validated;
  return validated;
}

function getStatePath(config: BudgetConfig, rootDir: string): string {
  return path.join(rootDir, config.stateFile);
}

function loadBudgetState(config: BudgetConfig, rootDir: string, logger?: Logger): BudgetState {
  if (budgetState) return budgetState;
  
  const statePath = getStatePath(config, rootDir);
  if (!fs.existsSync(statePath)) {
    budgetState = getEmptyState();
    return budgetState;
  }
  
  try {
    const content = fs.readFileSync(statePath, 'utf8');
    budgetState = JSON.parse(content) as BudgetState;
    hydrateReservations(budgetState);
    return budgetState;
  } catch (err) {
    logger?.warn(`Failed to parse budget state, resetting`, { path: statePath });
    budgetState = getEmptyState();
    hydrateReservations(budgetState);
    return budgetState;
  }
}

export function saveBudgetState(rootDir: string, logger?: Logger): void {
  if (!budgetConfig || !budgetState) return;
  
  const statePath = getStatePath(budgetConfig, rootDir);
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  // Atomic write: write to temp file, then rename (rename is atomic on POSIX)
  const tmpPath = statePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(budgetState, null, 2));
  fs.renameSync(tmpPath, statePath);
  logger?.debug('Budget state saved', { path: statePath });
}

export function addSpend(modelName: string, usd: number, rootDir: string, logger?: Logger): Promise<void> {
  // Serialize through a promise chain to prevent concurrent read-modify-write races
  spendQueue = spendQueue.then(() => {
    if (!budgetConfig) return;
    
    const state = loadBudgetState(budgetConfig, rootDir, logger);
    const dayKey = DAY_KEY();
    const monthKey = MONTH_KEY();
    
    state.global.daily[dayKey] = (state.global.daily[dayKey] ?? 0) + usd;
    state.global.monthly[monthKey] = (state.global.monthly[monthKey] ?? 0) + usd;
    
    if (!state.models[modelName]) {
      state.models[modelName] = { daily: {}, monthly: {} };
    }
    state.models[modelName].daily[dayKey] = (state.models[modelName].daily[dayKey] ?? 0) + usd;
    state.models[modelName].monthly[monthKey] = (state.models[modelName].monthly[monthKey] ?? 0) + usd;
    
    saveBudgetState(rootDir, logger);
  }, () => { /* noop — prior rejection doesn't block new adds */ });
  return spendQueue;
}

let pendingReservations = new Map<string, number>();

/**
 * Rebuild the in-memory reservation map from the persisted state file so a
 * fresh BudgetManager instance over the same state file still counts
 * reservations made by a previous instance. Stale reservations (different
 * day) are dropped.
 */
function hydrateReservations(state: BudgetState): void {
  pendingReservations.clear();
  const today = DAY_KEY();
  for (const [modelName, entries] of Object.entries(state.reservations ?? {})) {
    let total = 0;
    for (const entry of entries) {
      if (entry.dailyKey === today) total += entry.amount;
    }
    if (total > 0) pendingReservations.set(`res:${modelName}:d`, total);
  }
}

/**
 * Reserve an estimated cost before dispatching a job.
 * Returns {ok: true} if the reservation is within budget limits, {ok: false} otherwise.
 * The reservation is tracked in memory and must be released via releaseReservation().
 */
export function reserveBudget(
  modelName: string,
  estimatedCostUsd: number,
  rootDir: string,
  logger?: Logger,
): { ok: boolean; reason?: string } {
  if (!budgetConfig) return { ok: true };

  const state = loadBudgetState(budgetConfig, rootDir, logger);
  const modelLimits = budgetConfig.models?.[modelName];
  const globalLimits = budgetConfig.global;
  const thresholds = budgetConfig.thresholds ?? { warn: 80, block: 100 };

  const spentDaily = getSpendToday(state, modelName);
  const spentMonthly = getSpendMonth(state, modelName);
  const limitDaily = modelLimits?.daily ?? globalLimits?.daily;
  const limitMonthly = modelLimits?.monthly ?? globalLimits?.monthly;

  // Include all pending reservations in the projected spend
  const reservationKey = `res:${modelName}:d`;
  const totalReserved = (pendingReservations.get(reservationKey) ?? 0);

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

  // Reserve the estimated cost
  pendingReservations.set(reservationKey, totalReserved + estimatedCostUsd);
  if (!state.reservations) state.reservations = {};
  if (!state.reservations[modelName]) state.reservations[modelName] = [];
  state.reservations[modelName].push({ amount: estimatedCostUsd, dailyKey: DAY_KEY() });
  saveBudgetState(rootDir, logger);
  logger?.debug('Budget reserved', {
    model: modelName,
    estimatedCost: estimatedCostUsd,
    totalReserved: totalReserved + estimatedCostUsd,
    dailySpent: spentDaily,
    monthlySpent: spentMonthly,
  });

  return { ok: true };
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
  const reservationKey = `res:${modelName}:d`;
  const current = pendingReservations.get(reservationKey) ?? 0;
  const released = Math.max(0, current - estimatedCostUsd);
  if (released > 0) {
    pendingReservations.set(reservationKey, released);
  } else {
    pendingReservations.delete(reservationKey);
  }

  if (budgetConfig) {
    const state = loadBudgetState(budgetConfig, rootDir, logger);
    const entries = state.reservations?.[modelName];
    if (entries && entries.length > 0) {
      const today = DAY_KEY();
      const idx = entries.findIndex((entry) => entry.dailyKey === today);
      entries.splice(idx >= 0 ? idx : 0, 1);
      saveBudgetState(rootDir, logger);
    }
  }

  if (actualCostUsd > 0) {
    // Fire-and-forget — addSpend is serialized
    void addSpend(modelName, actualCostUsd, rootDir, logger);
  }

  logger?.debug('Budget reservation released', {
    model: modelName,
    estimatedCost: estimatedCostUsd,
    actualCost: actualCostUsd,
    remainingReserved: released,
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
  
  const state = loadBudgetState(budgetConfig, rootDir, logger);
  
  const modelLimits = budgetConfig.models?.[modelName];
  const globalLimits = budgetConfig.global;
  const thresholds = budgetConfig.thresholds ?? { warn: 80, block: 100 };
  
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
  
  const state = loadBudgetState(budgetConfig, rootDir, logger);
  
  const result = {
    global: {
      daily: { spent: getSpendToday(state), limit: budgetConfig.global?.daily ?? null },
      monthly: { spent: getSpendMonth(state), limit: budgetConfig.global?.monthly ?? null },
    },
    models: {} as Record<string, { daily: { spent: number; limit: number | null }; monthly: { spent: number; limit: number | null } }>,
  };
  
  const allModels = new Set(Object.keys(state.models));
  if (budgetConfig.models) {
    for (const m of Object.keys(budgetConfig.models)) allModels.add(m);
  }
  
  for (const modelName of allModels) {
    result.models[modelName] = {
      daily: { spent: getSpendToday(state, modelName), limit: budgetConfig.models?.[modelName]?.daily ?? null },
      monthly: { spent: getSpendMonth(state, modelName), limit: budgetConfig.models?.[modelName]?.monthly ?? null },
    };
  }
  
  return result;
}

export function resetBudgetCache(): void {
  budgetConfig = null;
  budgetState = null;
  spendQueue = Promise.resolve();
  pendingReservations.clear();
}
