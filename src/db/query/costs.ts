import { eq, sum, count, desc, asc, sql } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { cost_ledger } from '../schema.js';

// ── Cost Ledger ───────────────────────────────────────────────────────────

export async function insertCostLedgerEntry(data: {
  runId: string; model: string; costUsd: number; currency?: string;
  inputTokens?: number | null; outputTokens?: number | null;
  cacheReadTokens?: number | null; totalTokens?: number | null;
  pricingVersion?: string | null; recordedAt: string; finalizationAttempt?: number;
}): Promise<void> {
  const db = getDrizzleDb();
  // One ledger row per (run, model, finalization attempt): a finalize retry
  // that re-runs the same attempt's ledger write conflicts and is silently
  // dropped.
  await db.insert(cost_ledger).values({
    run_id: data.runId, model: data.model, cost_usd: data.costUsd,
    currency: data.currency ?? 'USD', input_tokens: data.inputTokens ?? null,
    output_tokens: data.outputTokens ?? null, cache_read_tokens: data.cacheReadTokens ?? null,
    total_tokens: data.totalTokens ?? null, pricing_version: data.pricingVersion ?? null,
    recorded_at: data.recordedAt,
    finalization_attempt: data.finalizationAttempt ?? 0,
  }).onConflictDoNothing({
    target: [cost_ledger.run_id, cost_ledger.model, cost_ledger.finalization_attempt],
  });
}

// ── Dashboard: cost analytics ─────────────────────────────────────────────

export interface CostSummaryRow {
  model: string | null;
  total_cost: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  entry_count: number | null;
}
export interface CostSummaryDayRow extends CostSummaryRow {
  period: string;
}

export async function getCostSummary(groupBy: 'model' | 'day', model?: string): Promise<CostSummaryDayRow[] | CostSummaryRow[]> {
  const db = getDrizzleDb();
  const where = model ? eq(cost_ledger.model, model) : undefined;
  const common = {
    total_cost: sum(cost_ledger.cost_usd),
    total_input_tokens: sum(cost_ledger.input_tokens),
    total_output_tokens: sum(cost_ledger.output_tokens),
    entry_count: count(),
  };
  if (groupBy === 'day') {
    return db.select({
      period: sql<string>`substr(${cost_ledger.recorded_at}, 1, 10)`,
      model: cost_ledger.model,
      ...common,
    })
      .from(cost_ledger)
      .where(where)
      .groupBy(sql`substr(${cost_ledger.recorded_at}, 1, 10)`, cost_ledger.model)
      .orderBy(desc(sql`substr(${cost_ledger.recorded_at}, 1, 10)`), asc(cost_ledger.model)) as CostSummaryDayRow[];
  }
  return db.select({ model: cost_ledger.model, ...common })
    .from(cost_ledger)
    .where(where)
    .groupBy(cost_ledger.model)
    .orderBy(desc(sum(cost_ledger.cost_usd))) as CostSummaryRow[];
}
