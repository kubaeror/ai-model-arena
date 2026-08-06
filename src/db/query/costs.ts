import { eq, sum, count, desc, asc, sql } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { cost_ledger } from '../schema.js';

// ── Cost Ledger ───────────────────────────────────────────────────────────

export async function insertCostLedgerEntry(data: {
  runId: string; model: string; costUsd: number; currency?: string;
  inputTokens?: number | null; outputTokens?: number | null;
  cacheReadTokens?: number | null; totalTokens?: number | null;
  pricingVersion?: string | null; recordedAt: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(cost_ledger).values({
    run_id: data.runId, model: data.model, cost_usd: data.costUsd,
    currency: data.currency ?? 'USD', input_tokens: data.inputTokens ?? null,
    output_tokens: data.outputTokens ?? null, cache_read_tokens: data.cacheReadTokens ?? null,
    total_tokens: data.totalTokens ?? null, pricing_version: data.pricingVersion ?? null,
    recorded_at: data.recordedAt,
  });
}

// ── Dashboard: cost analytics ─────────────────────────────────────────────

export async function getCostSummary(groupBy: 'model' | 'day', model?: string): Promise<any[]> {
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
      .orderBy(desc(sql`substr(${cost_ledger.recorded_at}, 1, 10)`), asc(cost_ledger.model)) as any;
  }
  return db.select({ model: cost_ledger.model, ...common })
    .from(cost_ledger)
    .where(where)
    .groupBy(cost_ledger.model)
    .orderBy(desc(sum(cost_ledger.cost_usd))) as any;
}
