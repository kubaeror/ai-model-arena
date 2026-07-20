interface Span {
  spanId?: string;
  name: string;
  startTime: number;
  endTime: number;
  attributes?: Record<string, unknown>;
}

export function aggregateLatency(spans: Span[], filterName?: string): { p50: number | null; p95: number | null } {
  const filtered = (filterName ? spans.filter(s => s.name === filterName) : spans);
  const durations = filtered.map(s => s.endTime - s.startTime).sort((a, b) => a - b);
  if (durations.length === 0) return { p50: null, p95: null };
  const p50 = durations[Math.floor(durations.length * 0.5)] ?? null;
  const p95 = durations[Math.floor(durations.length * 0.95)] ?? null;
  return { p50, p95 };
}

export function computeTps(spans: Span[], completionTokens: number): number | null {
  if (completionTokens <= 0) return null;
  const chatSpans = spans.filter(s => s.name === 'chat');
  if (chatSpans.length === 0) return null;
  const firstStart = Math.min(...chatSpans.map(s => s.startTime));
  const lastEnd = Math.max(...chatSpans.map(s => s.endTime));
  const durationMs = lastEnd - firstStart;
  if (durationMs <= 0) return null;
  return (completionTokens / durationMs) * 1000;
}
