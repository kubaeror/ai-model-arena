import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProducedByTool } from '../../src/sandbox/artifact-manifest.js';
import type { ConversationEntry } from '../../src/logger/conversation-logger.js';

function toolCall(partial: Partial<ConversationEntry> & { toolName: string; meta: { args: Record<string, unknown> } }): ConversationEntry {
  return { timestamp: '2026-01-01T00:00:00.000Z', type: 'tool_call', ...partial };
}

test('buildProducedByTool: edit_file wins over write_file on same path', () => {
  const conv: ConversationEntry[] = [
    toolCall({ toolName: 'write_file', meta: { args: { path: 'a.txt', content: 'v1' } } }),
    toolCall({ toolName: 'edit_file', meta: { args: { path: 'a.txt', old_string: 'v1', new_string: 'v2' } } }),
  ];
  assert.deepEqual(buildProducedByTool(conv), { 'a.txt': 'edit_file' });
});

test('buildProducedByTool: last write wins across multiple files', () => {
  const conv: ConversationEntry[] = [
    toolCall({ toolName: 'write_file', meta: { args: { path: 'a.txt', content: 'v1' } } }),
    toolCall({ toolName: 'write_file', meta: { args: { path: 'b.txt', content: 'x' } } }),
    toolCall({ toolName: 'write_file', meta: { args: { path: 'a.txt', content: 'v2' } } }),
  ];
  assert.deepEqual(buildProducedByTool(conv), { 'a.txt': 'write_file', 'b.txt': 'write_file' });
});

test('buildProducedByTool: non-file tools are ignored', () => {
  const conv: ConversationEntry[] = [
    toolCall({ toolName: 'run_shell_command', meta: { args: { command: 'ls' } } }),
    toolCall({ toolName: 'read_file', meta: { args: { path: 'a.txt' } } }),
    toolCall({ toolName: 'task_complete', meta: { args: { summary: 'done' } } }),
  ];
  assert.deepEqual(buildProducedByTool(conv), {});
});

test('buildProducedByTool: non tool_call entries are ignored', () => {
  const conv: ConversationEntry[] = [
    { timestamp: '2026-01-01T00:00:00.000Z', type: 'assistant', role: 'assistant', content: 'hi' },
    { timestamp: '2026-01-01T00:00:00.000Z', type: 'tool_result', toolName: 'write_file', toolResult: 'ok' },
  ];
  assert.deepEqual(buildProducedByTool(conv), {});
});

test('buildProducedByTool: missing or invalid file_path is skipped', () => {
  const conv: ConversationEntry[] = [
    toolCall({ toolName: 'write_file', meta: { args: {} } }),
    toolCall({ toolName: 'write_file', meta: { args: { path: 42 } } }),
    toolCall({ toolName: 'write_file', meta: { args: { path: '' } } }),
    toolCall({ toolName: 'write_file', meta: { args: { path: '   ' } } }),
    toolCall({ toolName: 'edit_file', meta: { args: { path: 'ok.txt', old_string: 'a', new_string: 'b' } } }),
  ];
  assert.deepEqual(buildProducedByTool(conv), { 'ok.txt': 'edit_file' });
});

test('buildProducedByTool: missing meta or args is skipped', () => {
  const conv: ConversationEntry[] = [
    toolCall({ toolName: 'write_file', meta: { args: { path: 'a.txt', content: 'x' } } }),
    { timestamp: '2026-01-01T00:00:00.000Z', type: 'tool_call', toolName: 'write_file' },
    { timestamp: '2026-01-01T00:00:00.000Z', type: 'tool_call', toolName: 'write_file', meta: {} },
    { timestamp: '2026-01-01T00:00:00.000Z', type: 'tool_call', toolName: 'write_file', meta: { args: 'not-an-object' } },
  ];
  assert.deepEqual(buildProducedByTool(conv), { 'a.txt': 'write_file' });
});

test('buildProducedByTool: supports file_path argument key', () => {
  const conv: ConversationEntry[] = [
    toolCall({ toolName: 'write_file', meta: { args: { file_path: 'legacy.txt', content: 'x' } } }),
  ];
  assert.deepEqual(buildProducedByTool(conv), { 'legacy.txt': 'write_file' });
});

test('buildProducedByTool: accepts empty conversation', () => {
  assert.deepEqual(buildProducedByTool([]), {});
});
