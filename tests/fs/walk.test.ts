import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { walkFiles } from '../../src/fs/walk.js';

describe('walkFiles', () => {
  let tmp: string;
  let root: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-walk-'));
    root = path.join(tmp, 'root');
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.mkdirSync(path.join(root, 'empty'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'top.txt'), 'top');
    fs.writeFileSync(path.join(root, 'a', 'a1.txt'), 'a1');
    fs.writeFileSync(path.join(root, 'a', 'b', 'a1b.txt'), 'a1b');
    fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'x');
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'y.js'), 'y');
    fs.writeFileSync(path.join(root, '.git', 'config'), 'cfg');
    // Symlinks must NOT be followed or returned.
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'alink'));
    fs.symlinkSync(path.join(root, 'top.txt'), path.join(root, 'filelink'));
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns sorted absolute file paths', () => {
    const files = walkFiles(root);
    const rels = files.map((f) => path.relative(root, f));
    assert.deepStrictEqual(rels, ['a/a1.txt', 'a/b/a1b.txt', 'top.txt']);
    assert.ok(files.every((f) => path.isAbsolute(f)));
  });

  it('excludes node_modules and .git by default', () => {
    const rels = walkFiles(root).map((f) => path.relative(root, f));
    assert.ok(!rels.some((r) => r.includes('node_modules') || r.includes('.git')));
  });

  it('excludes empty dirs unless dirs:true, and includes them with dirs:true', () => {
    assert.ok(!walkFiles(root).some((f) => path.basename(f) === 'empty'));
    const withDirs = walkFiles(root, { dirs: true }).map((f) => path.relative(root, f));
    assert.ok(withDirs.includes('empty'));
    assert.ok(withDirs.includes('a'));
    assert.ok(withDirs.includes('a/b'));
  });

  it('honors the exclude option', () => {
    const rels = walkFiles(root, { exclude: ['a'] }).map((f) => path.relative(root, f));
    assert.deepStrictEqual(rels, ['top.txt']);
  });

  it('does not follow or return symlinks', () => {
    const rels = walkFiles(root).map((f) => path.relative(root, f));
    assert.ok(!rels.includes('alink'));
    assert.ok(!rels.includes('filelink'));
  });

  it('returns [] for a nonexistent root without throwing', () => {
    assert.deepStrictEqual(walkFiles(path.join(tmp, 'nope')), []);
  });

  it('is deterministic across calls', () => {
    assert.deepStrictEqual(walkFiles(root), walkFiles(root));
  });
});
