import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILES,
  EXECUTION_PROFILES,
  getProfile,
} from '../../src/profiles/definitions.js';

const KNOWN_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'list_files', 'glob',
  'run_shell_command', 'search_code', 'web_fetch', 'web_search',
  'todo_read', 'todo_write', 'task', 'task_complete',
];

test('every profile with shellAllowed=true includes run_shell_command in allowedTools', () => {
  for (const name of EXECUTION_PROFILES) {
    const profile = PROFILES[name];
    if (profile.shellAllowed) {
      assert.ok(
        profile.allowedTools.includes('run_shell_command'),
        `${name} allows shell but omits run_shell_command`,
      );
    }
  }
});

test('every profile allowedTools are a subset of the 13 known tool names', () => {
  for (const name of EXECUTION_PROFILES) {
    const profile = PROFILES[name];
    for (const tool of profile.allowedTools) {
      assert.ok(
        KNOWN_TOOLS.includes(tool),
        `${name} allows unknown tool "${tool}"`,
      );
    }
  }
});

test('getProfile falls back to read-only-analysis for unknown profiles', () => {
  const fallback = getProfile('unknown');
  assert.equal(fallback.name, 'read-only-analysis');
});
