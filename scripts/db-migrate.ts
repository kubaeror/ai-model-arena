import path from 'node:path';
import fs from 'node:fs';
import { initDb, closeDb } from '../src/db/client.js';

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
const dbPath = process.env.ARENA_DB_PATH ?? path.join(root, 'outputs', 'arena.db');
initDb(dbPath);
console.log('Migrations applied successfully.');
closeDb();
