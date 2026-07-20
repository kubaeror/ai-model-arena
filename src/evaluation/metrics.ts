import type { ObjectiveMetrics, ToolCallRecord, LoopDetection } from './types.js';
import type { TokenUsage } from '../types.js';
import type { RunResult } from '../logger/result-logger.js';

export function computeObjectiveMetrics(
  result: RunResult,
  toolCalls: ToolCallRecord[],
  startTime: Date,
  endTime: Date
): ObjectiveMetrics {
  const cycleTimeSeconds = (endTime.getTime() - startTime.getTime()) / 1000;
  
  const toolStats = {
    total: result.totalToolCalls,
    failed: toolCalls.filter(tc => !tc.success).length,
    redundant: countRedundantCalls(toolCalls),
    loops: detectLoops(toolCalls).length,
    validation_errors: 0,
  };
  
  const turn_efficiency = result.turnsUsed > 0 
    ? (result.maxTurns - result.turnsUsed) / result.maxTurns 
    : 0;
  
  return {
    accepted_change_rate: result.success ? 1 : 0,
    turns_used: result.turnsUsed,
    max_turns: result.maxTurns,
    turns_remaining: result.maxTurns - result.turnsUsed,
    turn_efficiency,
    cycle_time_seconds: cycleTimeSeconds,
    tool_call_stats: toolStats,
    success: result.success,
    cost_usd: result.costUsd ?? 0,
  };
}

function countRedundantCalls(toolCalls: ToolCallRecord[]): number {
  let count = 0;
  const seen = new Map<string, number>();
  
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!;
    const key = `${tc.name}:${JSON.stringify(tc.arguments)}`;
    
    if (i > 0 && seen.has(key)) {
      const lastIndex = seen.get(key)!;
      if (lastIndex === i - 1) {
        count++;
      }
    }
    seen.set(key, i);
  }
  
  return count;
}

export function detectLoops(toolCalls: ToolCallRecord[]): LoopDetection[] {
  const loops: LoopDetection[] = [];
  
  for (let patternLen = 2; patternLen <= 5; patternLen++) {
    for (let start = 0; start <= toolCalls.length - patternLen * 3; start++) {
      const pattern = toolCalls.slice(start, start + patternLen).map(tc => tc.name);
      const patternKey = pattern.join(',');
      
      let repeatCount = 1;
      let nextStart = start + patternLen;
      
      while (nextStart + patternLen <= toolCalls.length) {
        const nextPattern = toolCalls.slice(nextStart, nextStart + patternLen).map(tc => tc.name);
        if (nextPattern.join(',') === patternKey) {
          repeatCount++;
          nextStart += patternLen;
        } else {
          break;
        }
      }
      
      if (repeatCount >= 3) {
        const turns = [];
        for (let r = 0; r < repeatCount; r++) {
          turns.push(...toolCalls.slice(start + r * patternLen, start + (r + 1) * patternLen).map(tc => tc.turn));
        }
        
        loops.push({
          type: 'cycle',
          turns: [...new Set(turns)].sort((a, b) => a - b),
          tools: pattern,
          description: `Tool pattern [${pattern.join(', ')}] repeated ${repeatCount} times`,
        });
        
        break;
      }
    }
  }
  
  return loops;
}

export function computeTotalTokens(usage: TokenUsage): number {
  return (usage.prompt ?? 0) + (usage.completion ?? 0);
}
