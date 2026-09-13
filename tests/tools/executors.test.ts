import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, listFiles, runShellCommand, editFile, globFiles, buildToolExecutors } from '../../src/tools/executors.js';
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

  it('runShellCommand reports missing binary as an error', async () => {
    const r = await runShellCommand({ command: 'definitely-not-a-real-binary-xyz' }, ctx);
    assert.strictEqual(r.isError, true, 'ENOENT must be an error, not a clean success');
    assert.ok(r.content.includes('not found'), `content should mention not found, got: ${r.content}`);
  });

  it('runShellCommand runs a real command', async () => {
    const r = await runShellCommand({ command: process.execPath + ' -p 41+1' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.ok(r.content.includes('42'));
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

  it('rejects absolute glob patterns without leaking host paths', async () => {
    const outsideAbs = path.join(tmp, 'glob-abs-outside.txt');
    fs.writeFileSync(outsideAbs, 'classified');
    const r = await globFiles({ pattern: outsideAbs }, ctx);
    assert.strictEqual(r.isError, true, `absolute pattern must be rejected, got: ${r.content}`);
    assert.ok(!r.content.includes(outsideAbs), `absolute path leaked: ${r.content}`);
    const host = await globFiles({ pattern: '/etc/hostname' }, ctx);
    assert.strictEqual(host.isError, true, `absolute host glob must be rejected, got: ${host.content}`);
    assert.ok(!host.content.includes('/etc/hostname'), `host path leaked: ${host.content}`);
  });

  it('rejects .. traversal patterns without leaking outside files', async () => {
    fs.writeFileSync(path.join(tmp, 'glob-outside-secret.txt'), 'classified');
    const r = await globFiles({ pattern: '../glob-outside-secret.txt' }, ctx);
    assert.strictEqual(r.isError, true, `traversal pattern must be rejected, got: ${r.content}`);
    assert.ok(!r.content.includes('glob-outside-secret'), `outside match leaked: ${r.content}`);
  });

  it('rejects ~-prefixed patterns', async () => {
    const r = await globFiles({ pattern: '~/*' }, ctx);
    assert.strictEqual(r.isError, true, `home-relative pattern must be rejected, got: ${r.content}`);
  });

  it('filters brace-expanded traversal matches that resolve outside the sandbox', async () => {
    fs.writeFileSync(path.join(tmp, 'glob-brace-outside.txt'), 'classified');
    const r = await globFiles({ pattern: '{..,src}/glob-brace-outside.txt' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.ok(!r.content.includes('glob-brace-outside'), `brace traversal leaked: ${r.content}`);
  });

  it('filters brace-expanded absolute matches that resolve outside the sandbox', async () => {
    const outsideAbs = path.join(tmp, 'glob-brace-abs.txt');
    fs.writeFileSync(outsideAbs, 'classified');
    const r = await globFiles({ pattern: `{${outsideAbs},${outsideAbs}.missing}` }, ctx);
    assert.strictEqual(r.isError, false);
    assert.ok(!r.content.includes('glob-brace-abs'), `brace absolute path leaked: ${r.content}`);
  });

  it('does not return files reached through an escaping symlinked directory', async () => {
    const outsideDir = path.join(tmp, 'glob-outside-dir');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'leak.txt'), 'classified');
    fs.symlinkSync(outsideDir, path.join(sandbox, 'glob-escape-dir'), 'dir');
    const r = await globFiles({ pattern: 'glob-escape-dir/*.txt' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.ok(!r.content.includes('leak.txt'), `escaped match leaked: ${r.content}`);
  });
});

// ── hardlink write containment ──────────────────────────────────────────────

describe('hardlink write containment', () => {
  before(() => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.mkdirSync(sandbox, { recursive: true });
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('write_file rejects a hardlink to a file outside the sandbox and leaves it unchanged', async () => {
    const outside = path.join(tmp, 'hardlink-write-outside.txt');
    const linked = path.join(sandbox, 'hardlink-write.txt');
    fs.writeFileSync(outside, 'original-outside');
    fs.linkSync(outside, linked);

    const r = await writeFile({ path: 'hardlink-write.txt', content: 'pwned' }, ctx);

    assert.strictEqual(r.isError, true, `hardlink write must be rejected, got: ${r.content}`);
    assert.match(r.content, /hardlink/i);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'original-outside');
    assert.strictEqual(fs.readFileSync(linked, 'utf8'), 'original-outside');
  });

  it('edit_file rejects a hardlink to a file outside the sandbox and leaves it unchanged', async () => {
    const outside = path.join(tmp, 'hardlink-edit-outside.txt');
    const linked = path.join(sandbox, 'hardlink-edit.txt');
    fs.writeFileSync(outside, 'original-outside');
    fs.linkSync(outside, linked);

    const r = await editFile({ path: 'hardlink-edit.txt', old_string: 'original', new_string: 'pwned' }, ctx);

    assert.strictEqual(r.isError, true, `hardlink edit must be rejected, got: ${r.content}`);
    assert.match(r.content, /hardlink/i);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'original-outside');
    assert.strictEqual(fs.readFileSync(linked, 'utf8'), 'original-outside');
  });

  it('write_file still overwrites files it created inside the sandbox', async () => {
    const first = await writeFile({ path: 'hardlink-created.txt', content: 'one' }, ctx);
    assert.strictEqual(first.isError, false);
    const second = await writeFile({ path: 'hardlink-created.txt', content: 'two' }, ctx);
    assert.strictEqual(second.isError, false);
    assert.strictEqual(fs.readFileSync(path.join(sandbox, 'hardlink-created.txt'), 'utf8'), 'two');
  });

  it('edit_file still edits files it created inside the sandbox', async () => {
    fs.writeFileSync(path.join(sandbox, 'hardlink-edited.txt'), 'hello world');
    const r = await editFile({ path: 'hardlink-edited.txt', old_string: 'hello', new_string: 'goodbye' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.strictEqual(fs.readFileSync(path.join(sandbox, 'hardlink-edited.txt'), 'utf8'), 'goodbye world');
  });
});

// ── run_shell_command timeout & maxBuffer observability ─────────────────────

describe('runShellCommand resource limits', () => {
  before(() => fs.mkdirSync(sandbox, { recursive: true }));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function limitedCtx(policy: 'strict' | 'permissive', maxShellOutputBytes = ctx.maxShellOutputBytes): ToolExecutionContext {
    return { ...ctx, shellTimeoutMs: 250, maxShellOutputBytes, shellPolicy: policy };
  }

  it('reports a timed-out command as an error (strict/execFile)', async () => {
    const started = Date.now();
    const r = await runShellCommand({ command: 'sleep 5' }, limitedCtx('strict'));
    const elapsed = Date.now() - started;
    assert.strictEqual(r.isError, true, `timeout must be an error, got: ${r.content}`);
    assert.match(r.content, /timed out after 250ms/);
    assert.ok(elapsed < 5000, `must not wait for the command to finish (${elapsed}ms)`);
  });

  it('reports a timed-out command as an error (permissive/exec)', async () => {
    const started = Date.now();
    const r = await runShellCommand({ command: 'sleep 5' }, limitedCtx('permissive'));
    const elapsed = Date.now() - started;
    assert.strictEqual(r.isError, true, `timeout must be an error, got: ${r.content}`);
    assert.match(r.content, /timed out after 250ms/);
    assert.ok(elapsed < 5000, `must not wait for the command to finish (${elapsed}ms)`);
  });

  it('returns truncated output instead of failing when maxBuffer is exceeded', async () => {
    const r = await runShellCommand(
      { command: `${process.execPath} -e "process.stdout.write('x'.repeat(200000))"` },
      limitedCtx('permissive', 4096),
    );
    assert.strictEqual(r.isError, false, `maxBuffer overflow is a truncated success, got: ${r.content}`);
    assert.match(r.content, /\(output truncated at 4096 bytes\)/);
  });
});

// ── search_code resource bounds ─────────────────────────────────────────────

describe('search_code', () => {
  const search = buildToolExecutors()['search_code']!;

  before(() => {
    fs.mkdirSync(sandbox, { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'search-basic.txt'), 'alpha\nBeta\nneedle here\ngamma needle\n');
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('finds plain substring matches with line numbers', async () => {
    const r = await search({ query: 'needle' }, ctx);
    assert.strictEqual(r.isError, false);
    assert.match(r.content, /search-basic\.txt:3: needle here/);
    assert.match(r.content, /search-basic\.txt:4: gamma needle/);
  });

  it('still supports safe regular expressions', async () => {
    const r = await search({ query: 'n(e+)dle', regex: true }, ctx);
    assert.strictEqual(r.isError, false);
    assert.match(r.content, /needle/);
  });

  it('rejects a catastrophic nested-quantifier regex instead of hanging', async () => {
    fs.writeFileSync(path.join(sandbox, 'search-redos.txt'), `${'a'.repeat(40)}!\n`);
    const started = Date.now();
    const r = await search({ query: '(a+)+$', regex: true }, ctx);
    const elapsed = Date.now() - started;
    assert.strictEqual(r.isError, true, `pathological regex must be rejected, got: ${r.content}`);
    assert.match(r.content, /catastrophic|backtracking/i);
    assert.ok(elapsed < 5000, `must return promptly, took ${elapsed}ms`);
  });

  it('aborts a regex search when the wall-clock budget is exceeded', async () => {
    // Deterministic budget trip: force the clock past the deadline without
    // depending on machine speed. The search runs synchronously, so the patch
    // cannot affect unrelated work.
    const realNow = Date.now;
    let calls = 0;
    Date.now = () => {
      calls += 1;
      return realNow() + (calls > 1 ? 60_000 : 0);
    };
    try {
      const r = await search({ query: 'needle', regex: true }, ctx);
      assert.strictEqual(r.isError, true, `budget must abort the search, got: ${r.content}`);
      assert.match(r.content, /budget/i);
    } finally {
      Date.now = realNow;
    }
  });
});

// ── search_code regex shape guard ───────────────────────────────────────────

describe('search_code regex shape guard', () => {
  const search = buildToolExecutors()['search_code']!;
  const shapeSandbox = path.join(tmp, 'shape-guard');
  const shapeCtx: ToolExecutionContext = { ...ctx, sandboxDir: shapeSandbox };

  before(() => {
    fs.mkdirSync(shapeSandbox, { recursive: true });
    // Short a-run only: if the guard regresses these inputs still finish fast.
    fs.writeFileSync(path.join(shapeSandbox, 'small.txt'), `${'a'.repeat(12)}!\n`);
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const accepted = ['(foo|bar)+', '(a|b)+', '[ab]+', 'a+', '(ab)*', '([ab]|c)+', '((foo|bar))+', '(a?b)+', '(a?)+', '(a|b){35}', '(ab){2,3}'];
  for (const query of accepted) {
    it(`accepts ${query}`, async () => {
      const r = await search({ query, regex: true }, shapeCtx);
      assert.strictEqual(r.isError, false, `expected ${query} to be accepted, got: ${r.content}`);
    });
  }

  const rejected = [
    '(a+)+$',
    '((a|aa))+$',
    '(a|a)+',
    '(a|aa)+',
    '(a+){2,}',
    '((a+))+$',
    '(a|ab)+',
    '(\\.|.)+',
    // Case-insensitive (the default) folding makes these branches overlap.
    '(a|A)+',
    '([a]|[A])+',
    '(foo|FOO)+',
    // Nullable leading atoms hide overlapping first characters.
    '(a?b|b)+',
    '(a{0,1}b|b)+',
    // Consecutive or overlapping nullable atoms make the repeat boundary ambiguous.
    '(a?a)+',
    '(a?b?)+',
    '((a?)(b?))+',
    // Bounded inner quantifiers still compose exponentially.
    '(a{2,3})+',
    '(a{1,2})+',
    '(a{0,2})+',
    // `[]` closes immediately in JS; the rest of the group must stay visible.
    '(a|[]x|a)+',
    // `[^]` is the negated empty class (matches any code unit), not an empty set.
    '([^]|a)+',
  ];
  for (const query of rejected) {
    it(`rejects ${query}`, async () => {
      const r = await search({ query, regex: true }, shapeCtx);
      assert.strictEqual(r.isError, true, `expected ${query} to be rejected, got: ${r.content}`);
      assert.match(r.content, /catastrophic|backtracking/i);
      assert.ok(
        r.content.includes(query.slice(0, -1)),
        `message must quote the offending group, got: ${r.content}`,
      );
    });
  }

  const rejectedShapes = [
    // Ambiguity under a bounded outer quantifier blows up multiplicatively.
    '^(a|aa){35}b$',
    '(a|aa){2}',
    '(a{2,3}){35}',
    // A long root-level run of nullable atoms before a required atom leaves
    // exponentially many ways to split the input.
    '^a?a?a?a?a?a?a?a?b$',
    `^${'a?'.repeat(30)}b$`,
  ];
  for (const query of rejectedShapes) {
    it(`rejects ${query}`, async () => {
      const r = await search({ query, regex: true }, shapeCtx);
      assert.strictEqual(r.isError, true, `expected ${query} to be rejected, got: ${r.content}`);
      assert.match(r.content, /catastrophic|backtracking/i);
    });
  }

  it('accepts case-variant branches when case-sensitive', async () => {
    const r = await search({ query: '(a|A)+', regex: true, caseSensitive: true }, shapeCtx);
    assert.strictEqual(r.isError, false, `expected case-sensitive \`(a|A)+\` to be accepted, got: ${r.content}`);
  });

  it('rejects a regex longer than the 500-character cap with an actionable error', async () => {
    const r = await search({ query: `^${'a'.repeat(501)}$`, regex: true }, shapeCtx);
    assert.strictEqual(r.isError, true, `over-long regex must be rejected, got: ${r.content}`);
    assert.match(r.content, /too long|500/);
  });
});
