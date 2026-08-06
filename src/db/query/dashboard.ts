import { count, desc, asc } from 'drizzle-orm';
import type { Column, SQL } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';

// ── Dashboard: generic paginated query helpers ────────────────────────────

/**
 * Resolve an `orderBy` string against a per-table column map, returning Drizzle
 * order expressions. Never interpolates raw identifiers into SQL. Each
 * comma-separated segment must be a key of `columns` (optionally suffixed with
 * ` ASC`/` DESC`); segments without an explicit direction use `dir` (or asc).
 */
function resolveOrderBy(
  columns: Record<string, Column>,
  orderBy: string | undefined,
  dir: 'asc' | 'desc' | undefined,
): SQL[] {
  const segments = (orderBy ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    const first = Object.keys(columns)[0]!;
    return [dir === 'desc' ? desc(columns[first]!) : asc(columns[first]!)];
  }
  const out: SQL[] = [];
  for (const segment of segments) {
    const m = /^(.+?)\s+(ASC|DESC)$/i.exec(segment);
    const key = (m ? m[1]! : segment).trim();
    const column = columns[key];
    if (!column) {
      throw new Error(`Refusing to sort by unknown column: ${JSON.stringify(key)}`);
    }
    const d = m ? m[2]!.toLowerCase() as 'asc' | 'desc' : (dir ?? 'asc');
    out.push(d === 'desc' ? desc(column) : asc(column));
  }
  return out;
}

/**
 * Paginate a table with Drizzle: total `count(*)` + `SELECT ... LIMIT/OFFSET`.
 *
 * `orderBy` is whitelisted against `columns` (no raw identifiers in SQL).
 * `offset` takes precedence over `page` when both are provided (route callers
 * speak limit/offset; tests speak page/pageSize).
 */
export async function paginate<T extends Record<string, unknown>>(
  table: object,
  columns: Record<string, Column>,
  q: {
    page?: number;
    pageSize: number;
    offset?: number;
    orderBy?: string;
    dir?: 'asc' | 'desc';
    where?: SQL;
  },
): Promise<{ rows: T[]; total: number }> {
  const db = getDrizzleDb();
  const pageSize = Math.max(q.pageSize, 1);
  const page = Math.max(q.page ?? 1, 1);
  const offset = q.offset ?? (page - 1) * pageSize;
  const conds = q.where;
  const countRows = await db.select({ count: count() }).from(table).where(conds);
  const total = (countRows[0]?.count ?? 0) as number;
  const order = resolveOrderBy(columns, q.orderBy, q.dir);
  const rows = await db.select()
    .from(table)
    .where(conds)
    .orderBy(...order)
    .limit(pageSize)
    .offset(offset);
  return { rows: rows as T[], total };
}
