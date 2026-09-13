import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { readTail } from '../../src/dashboard-server/routes/runs.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arena-read-tail-'));
}

async function referenceTail(filePath: string, lines: number): Promise<string> {
  const content = await fsp.readFile(filePath, 'utf8');
  return content.split(/\r?\n/).slice(-lines).join('\n');
}

test('readTail returns the same last N lines as a full read for a large file', async () => {
  const filePath = path.join(tmpDir(), 'big.log');
  const lines = Array.from({ length: 5000 }, (_, i) => `line-${i}-${'x'.repeat(64)}`);
  fs.writeFileSync(filePath, lines.join('\n'));

  assert.equal(await readTail(filePath, 400), await referenceTail(filePath, 400));
});

test('readTail matches the full read when the file has fewer lines than requested', async () => {
  const filePath = path.join(tmpDir(), 'small.log');
  fs.writeFileSync(filePath, 'alpha\nbeta\ngamma');

  assert.equal(await readTail(filePath, 400), await referenceTail(filePath, 400));
  assert.equal(await readTail(filePath, 400), 'alpha\nbeta\ngamma');
});

test('readTail preserves CRLF-equivalent output and trailing newlines', async () => {
  const filePath = path.join(tmpDir(), 'crlf.log');
  fs.writeFileSync(filePath, 'one\r\ntwo\r\nthree\r\n');

  assert.equal(await readTail(filePath, 2), await referenceTail(filePath, 2));
  assert.equal(await readTail(filePath, 10), await referenceTail(filePath, 10));
});

test('readTail handles empty and missing files', async () => {
  const emptyPath = path.join(tmpDir(), 'empty.log');
  fs.writeFileSync(emptyPath, '');

  assert.equal(await readTail(emptyPath, 400), '');
  assert.equal(await readTail(path.join(tmpDir(), 'missing.log'), 400), '');
});

test('readTail returns an empty string for lines <= 0', async () => {
  const filePath = path.join(tmpDir(), 'zero.log');
  fs.writeFileSync(filePath, 'alpha\nbeta\ngamma');

  assert.equal(await readTail(filePath, 0), '', 'zero lines must not return the whole file');
  assert.equal(await readTail(filePath, -5), '');
});

test('readTail does not corrupt multibyte characters split across read chunks', async () => {
  const filePath = path.join(tmpDir(), 'utf8.log');
  const lines = Array.from({ length: 4000 }, (_, i) => `行-${i}-${'あいうえお'.repeat(8)}`);
  fs.writeFileSync(filePath, lines.join('\n'));

  assert.equal(await readTail(filePath, 400), await referenceTail(filePath, 400));
});
