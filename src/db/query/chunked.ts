import { inArray, or, sql } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';

/**
 * SQLite caps bound variables per statement; one `IN (...)` over a large id set
 * can exceed the cap and fail the whole query closed (a live feed or anomaly
 * page vanishing). Splitting the set keeps every statement bounded.
 */
export const CHUNKED_IN_SIZE = 500;

/**
 * Build `column IN (chunk1) OR column IN (chunk2) ...` for arbitrarily large
 * id sets. An empty set yields `1 = 0` (matches nothing) so callers can never
 * accidentally widen the query to all rows.
 */
export function chunkedIn(
  column: AnyColumn,
  ids: readonly (string | number)[],
  size: number = CHUNKED_IN_SIZE,
): SQL {
  if (ids.length === 0) return sql`1 = 0`;
  const chunkSize = size > 0 ? Math.floor(size) : CHUNKED_IN_SIZE;
  const clauses: SQL[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    clauses.push(inArray(column, ids.slice(i, i + chunkSize)));
  }
  return clauses.length === 1 ? clauses[0]! : or(...clauses)!;
}
