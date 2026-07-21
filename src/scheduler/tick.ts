import { getDb } from '../db/client.js';

export async function tickScheduler(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const rows = db.prepare(
    "SELECT * FROM schedules WHERE enabled = 1 AND (next_run IS NULL OR next_run <= ?) ORDER BY next_run",
  ).all(now) as Array<Record<string, unknown>>;

  for (const row of rows) {
    const next = computeNextRun(String(row.cron), new Date(now));
    db.prepare('UPDATE schedules SET last_run = ?, next_run = ? WHERE id = ?').run(now, next, String(row.id));
  }
}

function computeNextRun(cron: string, from: Date): string {
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return new Date(from.getTime() + 3600000).toISOString();
  // Simple cron: "* * * * *" → every minute; "0 * * * *" → every hour at :00
  // For a full cron parser, a library would be used. Here we approximate.
  const minute = parts[0] ?? '*';
  const next = new Date(from);
  if (minute !== '*') {
    next.setMinutes(Number(minute));
    if (next <= from) next.setHours(next.getHours() + 1);
  } else {
    next.setMinutes(next.getMinutes() + 1);
  }
  return next.toISOString();
}
