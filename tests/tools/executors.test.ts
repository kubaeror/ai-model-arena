import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, listFiles, runShellCommand, editFile, globFiles } from '../../src/tools/executors.js';
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

describe('tool argument validation', () => {
  before(() => fs.mkdirSync(sandbox, { recursive: true }));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('writeFile rejects missing path', async () => {
    const r = await writeFile({ content: 'test' } as any, ctx);
    assert.strictEqual(r.isError, true);
    assert.ok(r.content.includes('path'), 'should reject missing path');
  });

  it('writeFile rejects extra properties', async () => {
    const r = await writeFile({ path: 'ok.txt', content: 'test', extra: 'bad' } as any, ctx);
    assert.strictEqual(r.isError, true);
  });

  it('readFile rejects missing path', async () => {
    const r = await readFile({} as any, ctx);
    assert.strictEqual(r.isError, true);
  });

  it('runShellCommand rejects missing command', async () => {
    const r = await runShellCommand({} as any, ctx);
    assert.strictEqual(r.isError, true);
  });

  it('listFiles rejects non-boolean recursive', async () => {
    const r = await listFiles({ recursive: 'yes' } as any, ctx);
    assert.strictEqual(r.isError, true);
  });
});

// ── editFile ──────────────────────────────────────────────────────────────

describe('editFile', () => {
  let testFile: string;
  before(() => { fs.mkdirSync(sandbox, { recursive: true }); testFile = path.join(sandbox, 'edit-test.ts'); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('replaces a single occurrence', async () => {
    fs.writeFileSync(testFile, 'const x = 1;\nconst y = 2;\n');
    const r = await editFile({ path: 'edit-test.ts', old_string: 'const x = 1;', new_string: 'let x = 1;' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.ok(r.content.includes('Replaced 1 occurrence'));
    assert.strictEqual(fs.readFileSync(testFile, 'utf8'), 'let x = 1;\nconst y = 2;\n');
  });

  it('replaces all occurrences with replace_all', async () => {
    fs.writeFileSync(testFile, 'foo bar foo baz foo');
    const r = await editFile({ path: 'edit-test.ts', old_string: 'foo', new_string: 'qux', replace_all: true }, ctx);
    assert.strictEqual(r.isError, false);
    assert.ok(r.content.includes('Replaced 3'));
    assert.strictEqual(fs.readFileSync(testFile, 'utf8'), 'qux bar qux baz qux');
  });

  it('rejects identical old and new strings', async () => {
    fs.writeFileSync(testFile, 'hello world');
    const r = await editFile({ path: 'edit-test.ts', old_string: 'hello', new_string: 'hello' }, ctx);
    assert.strictEqual(r.isError, true);
    assert.ok(r.content.includes('identical'));
  });

  it('rejects when old_string not found', async () => {
    fs.writeFileSync(testFile, 'hello world');
    const r = await editFile({ path: 'edit-test.ts', old_string: 'nope', new_string: 'yes' }, ctx);
    assert.strictEqual(r.isError, true);
    assert.ok(r.content.includes('not found'));
  });

  it('rejects when old_string appears multiple times (replace_all=false)', async () => {
    fs.writeFileSync(testFile, 'hello\nhello\nworld\nhello');
    const r = await editFile({ path: 'edit-test.ts', old_string: 'hello', new_string: 'hi' }, ctx);
    assert.strictEqual(r.isError, true);
    assert.ok(r.content.includes('found 3 times'));
    assert.ok(r.content.includes('lines:'));
    assert.ok(r.content.includes('1, 2, 4'));
  });

  it('rejects missing files', async () => {
    const r = await editFile({ path: 'nonexistent.ts', old_string: 'a', new_string: 'b' }, ctx);
    assert.strictEqual(r.isError, true);
  });
});

// ── globFiles (integration against a real fs tree) ─────────────────────────

const TS_FILES = [
  'src/index.ts',
  'src/utils.ts',
  'src/utils.test.ts',
  'src/deep/nested.ts',
  'chars/file-1.ts',
  'chars/file-ab.ts',
  'chars/file-a.ts',
  'chars/file-b.ts',
];

describe('globFiles', () => {
  before(() => {
    fs.mkdirSync(sandbox, { recursive: true });
    for (const rel of ['src/deep', 'src', 'lib', 'chars', 'node_modules/pkg', '.git', '.hidden']) {
      fs.mkdirSync(path.join(sandbox, rel), { recursive: true });
    }
    fs.writeFileSync(path.join(sandbox, 'src', 'index.ts'), '// index');
    fs.writeFileSync(path.join(sandbox, 'src', 'utils.ts'), '// utils');
    fs.writeFileSync(path.join(sandbox, 'src', 'utils.test.ts'), '// test');
    fs.writeFileSync(path.join(sandbox, 'src', 'deep', 'nested.ts'), '// nested');
    fs.writeFileSync(path.join(sandbox, 'lib', 'helper.js'), '// helper');
    fs.writeFileSync(path.join(sandbox, 'chars', 'file-1.ts'), '');
    fs.writeFileSync(path.join(sandbox, 'chars', 'file-ab.ts'), '');
    fs.writeFileSync(path.join(sandbox, 'chars', 'file-a.ts'), '');
    fs.writeFileSync(path.join(sandbox, 'chars', 'file-b.ts'), '');
    fs.writeFileSync(path.join(sandbox, 'README.md'), '# readme');
    fs.writeFileSync(path.join(sandbox, 'node_modules', 'pkg', 'bundle.js'), '// excluded');
    fs.writeFileSync(path.join(sandbox, '.git', 'config'), '# excluded');
    fs.writeFileSync(path.join(sandbox, '.hidden', 'dot.ts'), '// hidden dot');
    fs.writeFileSync(path.join(sandbox, '.gitignore'), '');
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('matches all .ts files with **/*.ts', async () => {
    const r = await globFiles({ pattern: '**/*.ts' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.deepStrictEqual(r.content.split('\n').sort(), [...TS_FILES].sort());
  });

  it('matches .js files only', async () => {
    const r = await globFiles({ pattern: '**/*.js' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.deepStrictEqual(r.content.split('\n').sort(), ['lib/helper.js']);
  });

  it('restricts search to a subdirectory with path', async () => {
    const r = await globFiles({ pattern: '*.ts', path: 'src' }, ctx);
    assert.strictEqual(r.isError, false);
    const matches = r.content.split('\n');
    assert.ok(matches.includes('src/index.ts'));
    assert.ok(matches.includes('src/utils.ts'));
    assert.ok(matches.includes('src/utils.test.ts'));
    assert.strictEqual(matches.length, 3);
  });

  it('matches brace expansion {a,b} natively', async () => {
    const r = await globFiles({ pattern: '**/*.{ts,js}' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.deepStrictEqual(r.content.split('\n').sort(), [...TS_FILES, 'lib/helper.js'].sort());
  });

  it('matches nested braces with a wildcard', async () => {
    const r = await globFiles({ pattern: 'src/**/*.{test,spec}.ts' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.deepStrictEqual(r.content.split('\n').sort(), ['src/utils.test.ts']);
  });

  it('matches ? as a single character', async () => {
    const r = await globFiles({ pattern: 'chars/file-?.ts' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.deepStrictEqual(r.content.split('\n').sort(), ['chars/file-1.ts', 'chars/file-a.ts', 'chars/file-b.ts']);
  });

  it('matches character class [abc]', async () => {
    const r = await globFiles({ pattern: 'chars/file-[ab].ts' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.deepStrictEqual(r.content.split('\n').sort(), ['chars/file-a.ts', 'chars/file-b.ts']);
  });

  it('excludes node_modules and .git subtrees', async () => {
    const r = await globFiles({ pattern: '**/*' }, ctx);
    assert.strictEqual(r.isError, false);
    const matches = r.content.split('\n');
    assert.ok(!matches.includes('node_modules/pkg/bundle.js'));
    assert.ok(!matches.includes('.git/config'));
  });

  it('does not match dotfiles/dot-dirs with * or ** wildcards', async () => {
    const dot = await globFiles({ pattern: '**/*.ts' }, ctx);
    assert.ok(!dot.content.split('\n').includes('.hidden/dot.ts'));
    const all = await globFiles({ pattern: '*' }, ctx);
    assert.ok(!all.content.split('\n').includes('.gitignore'));
  });

  it('matches dotfiles when the pattern names the dot explicitly', async () => {
    const gi = await globFiles({ pattern: '.gitignore' }, ctx);
    assert.deepStrictEqual(gi.content.split('\n'), ['.gitignore']);
    const hid = await globFiles({ pattern: '.hidden/*.ts' }, ctx);
    assert.deepStrictEqual(hid.content.split('\n'), ['.hidden/dot.ts']);
  });

  it('does not return directories, only regular files', async () => {
    const r = await globFiles({ pattern: '*' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.deepStrictEqual(r.content.split('\n'), ['README.md']);
  });

  it('returns empty when no files match', async () => {
    const r = await globFiles({ pattern: '**/*.py' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.strictEqual(r.content, 'No files matched.');
  });

  it('rejects missing directories', async () => {
    const r = await globFiles({ pattern: '*.ts', path: 'nonexistent' }, ctx);
    assert.strictEqual(r.isError, true);
  });
});
