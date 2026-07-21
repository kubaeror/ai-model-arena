import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapFileContent, detectInjection } from '../../src/security/prompt-injection.js';

test('wrapFileContent delimits + labels as data', () => {
  const out = wrapFileContent('src/app.ts', 'console.log("hi")');
  assert.match(out, /<arena_file path="src\/app\.ts">/);
  assert.match(out, /console\.log\("hi"\)/);
  assert.match(out, /<\/arena_file>/);
});

test('detectInjection flags task_complete in file content', () => {
  const r = detectInjection({ content: '... task_complete ...' });
  assert.equal(r.flagged, true);
});

test('detectInjection flags closing system tag', () => {
  const r = detectInjection({ content: '</system>' });
  assert.equal(r.flagged, true);
});

test('detectInjection passes clean content', () => {
  const r = detectInjection({ content: 'const x = 1;' });
  assert.equal(r.flagged, false);
});
