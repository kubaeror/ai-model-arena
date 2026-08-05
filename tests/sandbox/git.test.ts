import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SandboxGit } from '../../src/sandbox/git.js';

const execFileAsync = promisify(execFile);

async function git(dir: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd: dir });
  return result.stdout;
}

function makeSandboxDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arena-git-test-'));
}

test('init + commitFinal produces a git repo with a tracked file', async () => {
  const dir = makeSandboxDir();
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello world\n');

  const gitClient = new SandboxGit({ sandboxDir: dir, modelName: 'test-model' });
  await gitClient.init();

  assert.ok(fs.existsSync(path.join(dir, '.git')));
  assert.equal((await git(dir, ['ls-files'])).trim(), 'hello.txt');
  assert.ok((await git(dir, ['log', '--oneline'])).includes('Initial commit'));

  fs.appendFileSync(path.join(dir, 'hello.txt'), 'more content\n');
  const hash = await gitClient.commitFinal('task complete');

  assert.ok(hash, 'commitFinal should return a hash when changes exist');
  const log = await git(dir, ['log', '--oneline']);
  assert.ok(log.includes('run complete: task complete'));

  fs.rmSync(dir, { recursive: true });
});

test('generateDiff after a file edit returns a patch containing the change', async () => {
  const dir = makeSandboxDir();
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello world\n');

  const gitClient = new SandboxGit({ sandboxDir: dir, modelName: 'test-model' });
  await gitClient.init();

  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello world\nedited line\n');
  await gitClient.commitFinal('edited');

  const diff = await gitClient.generateDiff();
  assert.ok(diff.includes('+edited line'), 'diff should contain the added line');
  assert.ok(diff.includes('hello.txt'), 'diff should reference the changed file');

  fs.rmSync(dir, { recursive: true });
});

test('commitFinal on a repo with no changes returns without error', async () => {
  const dir = makeSandboxDir();
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello world\n');

  const gitClient = new SandboxGit({ sandboxDir: dir, modelName: 'test-model' });
  await gitClient.init();

  const hash = await gitClient.commitFinal('no changes here');
  assert.equal(hash, null, 'commitFinal should return null when there are no changes');
  assert.equal((await git(dir, ['rev-list', '--count', 'HEAD'])).trim(), '1');

  fs.rmSync(dir, { recursive: true });
});

test('init is idempotent and only creates one initial commit', async () => {
  const dir = makeSandboxDir();
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello world\n');

  const gitClient = new SandboxGit({ sandboxDir: dir, modelName: 'test-model' });
  await gitClient.init();
  await gitClient.init();

  assert.equal((await git(dir, ['rev-list', '--count', 'HEAD'])).trim(), '1');

  fs.rmSync(dir, { recursive: true });
});
