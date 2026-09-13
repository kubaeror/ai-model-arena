import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { todoRead, todoWrite } from '../../src/tools/todo.js';
import type { ToolExecutionContext } from '../../src/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-todo-'));
const sandbox = path.join(tmp, 'sandbox');

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => logger } as ToolExecutionContext['logger'];

const ctx: ToolExecutionContext = {
  sandboxDir: sandbox,
  logger,
  shellTimeoutMs: 30000,
  maxShellOutputBytes: 524288,
};

const TODO_MODULE_URL = new URL('../../src/tools/todo.ts', import.meta.url).href;

/** Run todoRead on `sandboxDir` in a child process so a blocking open cannot
 *  hang the test runner; a blocked child is killed by the timeout. */
function runTodoReadInChild(sandboxDir: string) {
  const code = `import(${JSON.stringify(TODO_MODULE_URL)}).then(async (m) => {
    const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
    const r = await m.todoRead({}, { sandboxDir: process.argv[1], logger, shellTimeoutMs: 1000, maxShellOutputBytes: 1024 });
    console.log('CONTENT:' + JSON.stringify(r.content));
  });`;
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, sandboxDir], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
  });
}

describe('todoRead + todoWrite', () => {
  before(() => fs.mkdirSync(sandbox, { recursive: true }));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('todoRead returns empty when no todos exist', async () => {
    const r = await todoRead({}, ctx);
    assert.strictEqual(r.isError, false);
    assert.ok(r.content.includes('(no tasks)'));
  });

  it('todoWrite stores and todoRead returns todos', async () => {
    const todos = [
      { id: '1', content: 'Write tests', status: 'pending' as const, priority: 'high' as const },
      { id: '2', content: 'Refactor core', status: 'in_progress' as const, priority: 'medium' as const },
      { id: '3', content: 'Update README', status: 'completed' as const, priority: 'low' as const },
    ];
    const w = await todoWrite({ todos }, ctx);
    assert.strictEqual(w.isError, false);
    assert.ok(w.content.includes('1 pending'));
    assert.ok(w.content.includes('1 in_progress'));
    assert.ok(w.content.includes('1 completed'));

    const r = await todoRead({}, ctx);
    assert.strictEqual(r.isError, false);
    assert.ok(r.content.includes('Write tests'));
    assert.ok(r.content.includes('Refactor core'));
    assert.ok(r.content.includes('Update README'));
    assert.ok(r.content.includes('[high]'));
    assert.ok(r.content.includes('[medium]'));
    assert.ok(r.content.includes('[low]'));
  });

  it('todoWrite replaces previous todos', async () => {
    const todos = [{ id: 'a', content: 'Just one task', status: 'pending' as const, priority: 'medium' as const }];
    await todoWrite({ todos }, ctx);
    const r = await todoRead({}, ctx);
    assert.ok(r.content.includes('Just one task'));
    assert.ok(!r.content.includes('Write tests'));
  });

  it('todoWrite rejects empty todos array', async () => {
    const r = await todoWrite({ todos: [] }, ctx);
    assert.strictEqual(r.isError, true);
  });

  it('todoWrite rejects missing todos', async () => {
    const r = await todoWrite({} as any, ctx);
    assert.strictEqual(r.isError, true);
  });

  it('todoWrite rejects invalid status', async () => {
    const r = await todoWrite({ todos: [{ id: '1', content: 'bad', status: 'done', priority: 'high' }] }, ctx);
    assert.strictEqual(r.isError, true);
  });

  it('persists across executor calls', async () => {
    const todos = [
      { id: '1', content: 'Persisted task', status: 'in_progress' as const, priority: 'high' as const },
    ];
    await todoWrite({ todos }, ctx);
    const r = await todoRead({}, ctx);
    assert.ok(r.content.includes('Persisted task'));
  });

  it('rejects a hardlinked .arena/todos.json and leaves the outside file unchanged', async () => {
    const outside = path.join(tmp, 'outside-todos.json');
    fs.writeFileSync(outside, 'outside-original');
    fs.mkdirSync(path.join(sandbox, '.arena'), { recursive: true });
    const link = path.join(sandbox, '.arena', 'todos.json');
    fs.rmSync(link, { force: true });
    fs.linkSync(outside, link);

    const r = await todoWrite({
      todos: [{ id: 'x', content: 'escape attempt', status: 'pending' as const, priority: 'high' as const }],
    }, ctx);
    assert.strictEqual(r.isError, true, `hardlink write must be rejected, got: ${r.content}`);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside-original');
  });

  it('rejects a symlinked .arena directory without writing outside the sandbox', async () => {
    const outsideDir = path.join(tmp, 'outside-arena');
    fs.mkdirSync(outsideDir, { recursive: true });
    const symlinkCtx: ToolExecutionContext = { ...ctx, sandboxDir: fs.mkdtempSync(path.join(tmp, 'todo-symlink-sb-')) };
    fs.symlinkSync(outsideDir, path.join(symlinkCtx.sandboxDir, '.arena'), 'dir');

    const r = await todoWrite({
      todos: [{ id: 'y', content: 'symlink attempt', status: 'pending' as const, priority: 'high' as const }],
    }, symlinkCtx);
    assert.strictEqual(r.isError, true, `symlinked .arena must be rejected, got: ${r.content}`);
    assert.ok(!fs.existsSync(path.join(outsideDir, 'todos.json')), 'outside dir must not receive todos.json');
  });

  it('todoRead reads a read-only todos.json without an O_WRONLY open', async () => {
    const roCtx: ToolExecutionContext = { ...ctx, sandboxDir: fs.mkdtempSync(path.join(tmp, 'todo-readonly-')) };
    fs.mkdirSync(path.join(roCtx.sandboxDir, '.arena'), { recursive: true });
    const fp = path.join(roCtx.sandboxDir, '.arena', 'todos.json');
    fs.writeFileSync(fp, JSON.stringify([
      { id: 'ro', content: 'Read-only task', status: 'pending', priority: 'high' },
    ]));
    fs.chmodSync(fp, 0o444);

    try {
      const r = await todoRead({}, roCtx);
      assert.strictEqual(r.isError, false);
      assert.ok(r.content.includes('Read-only task'), `read-only todos must be read, got: ${r.content}`);
    } finally {
      fs.chmodSync(fp, 0o644);
    }
  });

  it('todoRead still rejects a symlinked .arena directory', async () => {
    const outsideDir = path.join(tmp, 'outside-arena-read');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'todos.json'), JSON.stringify([
      { id: 'leak', content: 'Outside secret', status: 'pending', priority: 'high' },
    ]));
    const symlinkCtx: ToolExecutionContext = { ...ctx, sandboxDir: fs.mkdtempSync(path.join(tmp, 'todo-symlink-read-sb-')) };
    fs.symlinkSync(outsideDir, path.join(symlinkCtx.sandboxDir, '.arena'), 'dir');

    const r = await todoRead({}, symlinkCtx);
    assert.ok(!r.content.includes('Outside secret'), 'a symlinked .arena must not leak outside todos');
    assert.ok(r.content.includes('(no tasks)'));
  });

  it('todoRead rejects a hardlinked todos.json without leaking outside content', async () => {
    const outside = path.join(tmp, 'outside-read-todos.json');
    const secret = JSON.stringify([
      { id: 'leak', content: 'OUTSIDE-SECRET', status: 'pending', priority: 'high' },
    ]);
    fs.writeFileSync(outside, secret);
    const readCtx: ToolExecutionContext = { ...ctx, sandboxDir: fs.mkdtempSync(path.join(tmp, 'todo-hardlink-read-')) };
    fs.mkdirSync(path.join(readCtx.sandboxDir, '.arena'), { recursive: true });
    fs.linkSync(outside, path.join(readCtx.sandboxDir, '.arena', 'todos.json'));

    const r = await todoRead({}, readCtx);
    assert.strictEqual(r.isError, false);
    assert.ok(!r.content.includes('OUTSIDE-SECRET'), `hardlinked todos must not leak, got: ${r.content}`);
    assert.ok(r.content.includes('(no tasks)'));
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), secret, 'outside file must be unchanged');
  });

  it('todoRead rejects a FIFO todos.json without blocking', { skip: process.platform === 'win32' }, () => {
    const fifoCtx: ToolExecutionContext = { ...ctx, sandboxDir: fs.mkdtempSync(path.join(tmp, 'todo-fifo-')) };
    fs.mkdirSync(path.join(fifoCtx.sandboxDir, '.arena'), { recursive: true });
    execFileSync('mkfifo', [path.join(fifoCtx.sandboxDir, '.arena', 'todos.json')]);

    const result = runTodoReadInChild(fifoCtx.sandboxDir);
    assert.equal(result.error, undefined, `todoRead must not block on a FIFO: ${(result.error as NodeJS.ErrnoException | undefined)?.code ?? ''}`);
    assert.equal(result.status, 0, `expected status 0, got ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /CONTENT:.*\(no tasks\)/);
  });
});
