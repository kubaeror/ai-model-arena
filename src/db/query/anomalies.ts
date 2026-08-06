import { count, sum, sql, desc } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { anomalies } from '../schema.js';

// ── Anomaly counts ────────────────────────────────────────────────────────

export async function anomalyCountsByModel(): Promise<Array<{ model: string; total: number; unresolved: number }>> {
  const db = getDrizzleDb();
  const rows = await db.select({
    model: anomalies.model,
    total: count(),
    unresolved: sum(sql<number>`CASE WHEN ${anomalies.resolved} = 0 THEN 1 ELSE 0 END`),
  })
    .from(anomalies)
    .groupBy(anomalies.model)
    .orderBy(desc(count()));
  return (rows as Array<{ model: string; total: unknown; unresolved: unknown }>)
    .map(r => ({ model: r.model, total: Number(r.total), unresolved: Number(r.unresolved) }));
}
