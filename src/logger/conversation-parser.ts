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

export interface LoopIncident {
  runId: string;
  model: string;
  turn: number;
  tools: string[];
}

export interface ConsecutiveLoop {
  tool: string;
  consecutive: number;
  turns: number[];
}

/** Detect N+ consecutive identical tool+arguments calls (anomaly detector semantics). */
export function detectLoops(toolCalls: ToolCallEntry[], minConsecutive: number): ConsecutiveLoop | null {
  for (let i = 0; i <= toolCalls.length - minConsecutive; i++) {
    const key = `${toolCalls[i]!.name}:${JSON.stringify(toolCalls[i]!.arguments)}`;
    let n = 1;
    const turns = [toolCalls[i]!.turn];
    for (let j = i + 1; j < toolCalls.length; j++) {
      if (`${toolCalls[j]!.name}:${JSON.stringify(toolCalls[j]!.arguments)}` === key) { n++; turns.push(toolCalls[j]!.turn); }
      else break;
    }
    if (n >= minConsecutive) return { tool: toolCalls[i]!.name, consecutive: n, turns };
  }
  return null;
}

/** Detect 3+ consecutive turns with an identical tool-name sequence (analytics semantics). */
export function detectTurnLoops(conv: Record<string, unknown>): LoopIncident[] {
  const entries = (conv.entries as Array<Record<string, unknown>>) ?? [];
  const incidents: LoopIncident[] = [];
  const turnTools = new Map<number, string[]>();
  for (const entry of entries) {
    if (entry.type === 'tool_call') {
      const turn = (entry.turn as number) ?? 0;
      const toolName = entry.toolName as string;
      if (!turnTools.has(turn)) turnTools.set(turn, []);
      turnTools.get(turn)!.push(toolName);
    }
  }
  const turns = Array.from(turnTools.keys()).sort((a, b) => a - b);
  for (let i = 0; i < turns.length - 2; i++) {
    const t1 = turnTools.get(turns[i]!) ?? [];
    const t2 = turnTools.get(turns[i + 1]!) ?? [];
    const t3 = turnTools.get(turns[i + 2]!) ?? [];
    if (t1.length > 0 && JSON.stringify(t1) === JSON.stringify(t2) && JSON.stringify(t2) === JSON.stringify(t3)) {
      incidents.push({ runId: (conv.runId as string) ?? '', model: (conv.meta as Record<string, unknown>)?.model as string ?? '', turn: turns[i]!, tools: t1 });
    }
  }
  return incidents;
}
