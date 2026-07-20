export interface ToolCallEntry {
  name: string;
  turn: number;
  success: boolean;
  arguments?: Record<string, unknown>;
}

/**
 * Extract ordered tool calls (with success/failure) from a conversation.json
 * `entries` array. This is the single canonical parser — do not duplicate.
 */
export function extractToolCallsFromConversation(
  conv: Record<string, unknown>,
): ToolCallEntry[] {
  const entries = (conv.entries as Array<Record<string, unknown>>) ?? [];
  const calls: ToolCallEntry[] = [];
  let currentTurn = 0;
  for (const entry of entries) {
    const type = entry.type as string;
    if (type === 'assistant') {
      currentTurn = typeof entry.turn === 'number' ? entry.turn : currentTurn + 1;
    } else if (type === 'tool_call') {
      calls.push({
        name: String(entry.toolName ?? ''),
        turn: currentTurn,
        success: true,
        arguments: ((entry.meta as Record<string, unknown>)?.args as Record<string, unknown>) ?? {},
      });
    } else if (type === 'tool_result') {
      const name = String(entry.toolName ?? '');
      const isError = Boolean(entry.isError);
      // Find the last matching call in the current turn and update success.
      const last = [...calls].reverse().find((c) => c.turn === currentTurn && c.name === name);
      if (last) last.success = !isError;
    }
  }
  return calls;
}
