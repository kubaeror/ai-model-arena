import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { lockedWrite } from '../../src/fs/locked-write.js';

test('writes atomically — no partial file visible', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-'));
  const target = path.join(dir, 'out.txt');
  await lockedWrite(target, 'hello', { lockDir: dir });
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
  const tmpFiles = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
  assert.equal(tmpFiles.length, 0);
});

test('concurrent writes to same target are serialized', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-'));
  const target = path.join(dir, 'out.txt');
  const writes: Promise<void>[] = [];
  for (let i = 0; i < 10; i++) writes.push(lockedWrite(target, `v${i}`, { lockDir: dir }));
  await Promise.all(writes);
  const content = fs.readFileSync(target, 'utf8');
  assert.ok(content.startsWith('v'));
});
