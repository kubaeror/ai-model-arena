import { createSessionStore } from '../session/store.js';
import type { ChatMessage } from '../types.js';
import type { StoredMessage } from '../session/store.js';

export interface ResumeResult {
  messages: ChatMessage[];
  lastCompletedTurn: number;
}

function storedToChat(msg: StoredMessage): ChatMessage {
  return {
    role: msg.role as ChatMessage['role'],
    content: msg.content,
    toolCalls: msg.toolCalls ? JSON.parse(msg.toolCalls) : undefined,
    toolCallId: msg.toolCallId ?? undefined,
  };
}

export async function resumeFrom(sessionId: string): Promise<ResumeResult> {
  const store = createSessionStore();
  const msgs = await store.listMessages(sessionId);
  let lastCompletedTurn = -1;
  for (const m of msgs) {
    const mc = await store.getModelCall(sessionId, m.turn);
    if (mc) lastCompletedTurn = Math.max(lastCompletedTurn, m.turn);
  }
  return {
    messages: msgs.map(storedToChat),
    lastCompletedTurn,
  };
}
