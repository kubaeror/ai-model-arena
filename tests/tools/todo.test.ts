import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
});
