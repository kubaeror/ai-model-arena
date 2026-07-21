import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile } from '../../src/tools/executors.js';
import type { ToolExecutionContext } from '../../src/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-exec-'));
const sandbox = path.join(tmp, 'sandbox');

const ctx: ToolExecutionContext = {
  sandboxDir: sandbox,
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
  shellTimeoutMs: 30000,
  maxShellOutputBytes: 524288,
  shellPolicy: 'strict',
};

describe('readFile', () => {
  before(() => fs.mkdirSync(sandbox, { recursive: true }));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('reads a normal file', async () => {
    fs.writeFileSync(path.join(sandbox, 'hello.txt'), 'hello world');
    const r = await readFile({ path: 'hello.txt' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.ok(r.content.includes('hello world'), 'should contain file content');
    assert.ok(r.content.includes('<arena_file'), 'should wrap in arena_file tags');
  });

  it('rejects missing files', async () => {
    const r = await readFile({ path: 'nope.txt' }, ctx);
    assert.strictEqual(r.isError, true);
  });

  it('rejects a symlink that escapes the sandbox', async () => {
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(sandbox, 'escape'));
    await assert.rejects(
      () => readFile({ path: 'escape' }, ctx),
      /escapes the sandbox/,
    );
  });

  it('rejects files exceeding MAX_READ_BYTES', async () => {
    const huge = path.join(sandbox, 'large.bin');
    const buf = Buffer.alloc(300 * 1024, 0x41);
    fs.writeFileSync(huge, buf);
    const r = await readFile({ path: 'large.bin' }, ctx);
    assert.strictEqual(r.isError, true);
    assert.ok(r.content.includes('exceeds'));
  });
});

describe('writeFile limits', () => {
  before(() => fs.mkdirSync(sandbox, { recursive: true }));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('writes a normal file', async () => {
    const r = await writeFile({ path: 'test.txt', content: 'hello' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.ok(fs.existsSync(path.join(sandbox, 'test.txt')));
  });

  it('rejects files exceeding the max write size', async () => {
    const huge = 'x'.repeat(6 * 1024 * 1024); // 6MB
    const r = await writeFile({ path: 'huge.txt', content: huge }, ctx);
    assert.strictEqual(r.isError, true);
    assert.ok(r.content.includes('exceeds'));
  });
});
