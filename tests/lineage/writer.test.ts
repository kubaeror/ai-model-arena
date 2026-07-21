import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb } from '../../src/db/client.js';
import { writeWithLineage } from '../../src/lineage/writer.js';

test('writeWithLineage creates file + sidecar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-'));
  initDb(':memory:');
  const target = path.join(dir, 'hello.txt');
  await writeWithLineage(target, 'world', { runId: 'r1', model: 'gpt-4o', sandboxDir: dir, tool: 'write_file' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'world');
  const sidecar = fs.readFileSync(`${target}.lineage.json`, 'utf8');
  const lineage = JSON.parse(sidecar);
  assert.equal(lineage.path, 'hello.txt');
  assert.equal(lineage.model, 'gpt-4o');
  closeDb();
});
