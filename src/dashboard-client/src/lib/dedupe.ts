/** Keep the first occurrence of each row id so overlapping offset pages never render duplicates. */
export function dedupeById<T extends { id?: unknown }>(rows: readonly T[]): T[] {
  const seen = new Set<unknown>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}
