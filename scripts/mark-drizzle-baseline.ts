import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Read the SQL migration file and compute its hash (matching Drizzle's algorithm)
const drizzleDir = path.resolve(process.cwd(), 'drizzle');
const sqlPath = path.join(drizzleDir, '0000_baseline.sql');
const query = fs.readFileSync(sqlPath, 'utf8');
const hash = crypto.createHash('sha256').update(query).digest('hex');

const db = new Database('./outputs/arena.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  created_at NUMERIC
)`);

const existing = db.prepare('SELECT hash FROM __drizzle_migrations').all() as { hash: string }[];
if (existing.length > 0) {
  console.log('__drizzle_migrations already populated, skipping.');
} else {
  db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(hash, Date.now());
  console.log(`Baseline migration marked as applied (hash: ${hash.slice(0, 12)}...)`);
}

db.close();
