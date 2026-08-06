import { percentile } from './percentile.js';

// Span schema matches observability/trace-meta.ts (what the runner writes).
interface Span {
  spanId?: string;
  name: string;
  startedAt: number;
  endedAt: number;
  attributes?: Record<string, unknown>;
}

export function aggregateLatency(spans: Span[], filterName?: string): { p50: number | null; p95: number | null } {
  const filtered = (filterName ? spans.filter(s => s.name === filterName) : spans);
  const durations = filtered.map(s => s.endedAt - s.startedAt).sort((a, b) => a - b);
  if (durations.length === 0) return { p50: null, p95: null };
  return {
    p50: percentile(durations, 50) ?? null,
    p95: percentile(durations, 95) ?? null,
  };
}

export function computeTps(spans: Span[], completionTokens: number): number | null {
  if (completionTokens <= 0) return null;
  const chatSpans = spans.filter(s => s.name === 'chat');
  if (chatSpans.length === 0) return null;
  const firstStart = Math.min(...chatSpans.map(s => s.startedAt));
  const lastEnd = Math.max(...chatSpans.map(s => s.endedAt));
  const durationMs = lastEnd - firstStart;
  if (durationMs <= 0) return null;
  return (completionTokens / durationMs) * 1000;
}
