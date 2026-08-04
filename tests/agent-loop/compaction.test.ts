import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactMessages } from '../../src/agent-loop/loop.js';
import type { ChatMessage } from '../../src/types.js';

const BIG = 'x'.repeat(50_000);

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content };
}

test('compactMessages drops oldest droppable messages when over the cap', () => {
  // system + task + 6 tool turns, each ~50KB → ~400KB total.
  const messages: ChatMessage[] = [
    msg('system', 'sys'),
    msg('user', 'task'),
    msg('assistant', 'a1'), msg('tool', BIG),
    msg('assistant', 'a2'), msg('tool', BIG),
    msg('assistant', 'a3'), msg('tool', BIG),
    msg('assistant', 'a4'), msg('tool', BIG),
    msg('assistant', 'a5'), msg('tool', BIG),
    msg('assistant', 'a6'), msg('tool', BIG),
  ];
  compactMessages(messages, 4);
  // system + task always survive.
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[1]?.role, 'user');
  assert.equal(messages[1]?.content, 'task');
  // Tail (last 4 messages) survives.
  const tail = messages.slice(-4).map((m) => m.content);
  assert.deepEqual(tail, ['a5', BIG, 'a6', BIG]);
  // Total now under the cap.
  const total = messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0);
  assert.ok(total <= 150_000, `expected <= 150k, got ${total}`);
});

test('compactMessages leaves small conversations untouched', () => {
  const messages: ChatMessage[] = [
    msg('system', 'sys'),
    msg('user', 'task'),
    msg('assistant', 'a1'),
    msg('tool', 'result'),
  ];
  const before = messages.length;
  compactMessages(messages, 4);
  assert.equal(messages.length, before);
});

test('compactMessages never drops system+task even when huge', () => {
  const messages: ChatMessage[] = [
    msg('system', BIG),
    msg('user', BIG),
    msg('assistant', 'a1'),
    msg('tool', BIG),
  ];
  compactMessages(messages, 4);
  assert.equal(messages.length, 4);
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[1]?.role, 'user');
});
