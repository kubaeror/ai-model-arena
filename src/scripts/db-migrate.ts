import { initDb, closeDb } from '../db/index.js';
import { migratePostgres, getPgClient } from '../db/postgres.js';

const driver = (process.env.DB_DRIVER ?? 'sqlite').toLowerCase();
console.log(`Running migrations on ${driver}...`);

if (driver === 'postgres') {
  // initDb sets up the pool but doesn't run drizzle migrations — run them explicitly
  initDb();
  const client = getPgClient();
  await migratePostgres(client);
} else {
  // SQLite: initDb handles migrations automatically
  initDb();
}

console.log('Migrations applied successfully.');
await closeDb();
