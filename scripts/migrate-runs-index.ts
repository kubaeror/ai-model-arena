import fs from 'node:fs';
import path from 'node:path';
import { initDb, closeDb } from '../src/db/client.js';
import { upsertRun } from '../src/db/runs.js';
import type { RunIndexFile } from '../src/db/runs.js';

function findProjectRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const root = findProjectRoot();
const idxPath = path.join(root, 'outputs', 'runs-index.json');
if (!fs.existsSync(idxPath)) {
  console.log('No runs-index.json found, nothing to backfill.');
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(idxPath, 'utf8')) as RunIndexFile;
if (!raw.runs || raw.runs.length === 0) {
  console.log('runs-index.json is empty, nothing to backfill.');
  process.exit(0);
}

const dbPath = process.env.ARENA_DB_PATH ?? path.join(root, 'outputs', 'arena.db');
initDb(dbPath);

(async () => {
  for (const r of raw.runs) {
    await upsertRun(r);
  }
  console.log(`Backfilled ${raw.runs.length} runs.`);
  closeDb();
})().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
