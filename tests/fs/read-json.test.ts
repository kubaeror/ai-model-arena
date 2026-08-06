import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile } from '../../src/fs/read-json.js';

test('readJsonFile returns parsed JSON', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rj-'));
  const f = path.join(dir, 'a.json');
  await fsp.writeFile(f, JSON.stringify({ ok: 1 }));
  assert.deepEqual(await readJsonFile<{ ok: number }>(f), { ok: 1 });
});

test('readJsonFile returns null for missing file', async () => {
  assert.equal(await readJsonFile<unknown>('/nonexistent/x.json'), null);
});

test('readJsonFile returns null for invalid JSON', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rj-'));
  const f = path.join(dir, 'bad.json');
  await fsp.writeFile(f, 'not json');
  assert.equal(await readJsonFile<unknown>(f), null);
});
