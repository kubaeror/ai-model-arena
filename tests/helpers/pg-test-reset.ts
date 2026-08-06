/**
 * Test bootstrap for the Postgres suite (`test:db-pg`).
 *
 * Loaded via `NODE_OPTIONS=--import` so it runs at the start of EVERY test-file
 * process. It connects to the shared PG database and empties the `public`
 * tables, mirroring the blank `:memory:` database each sqlite test file gets.
 * Gated on `PG_TEST_RESET=1` — never active in production or the sqlite suite.
 *
 * Deliberately imports only the `pg` package (not `src/`): the Node type
 * stripper that loads this module cannot remap `.js` specifiers to `.ts`.
 * This is the same reset `closePostgres()` performs per-test under
 * `PG_TEST_RESET=1`.
 */
import pg from 'pg';

if (process.env.DB_DRIVER === 'postgres' && process.env.PG_TEST_RESET === '1') {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const { rows } = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
  );
  const tables = rows.map((r) => r.tablename);
  if (tables.length > 0) {
    await pool.query(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  }
  await pool.end();
}
