import { useMemo } from 'react';
import type { SpanMeta, TraceTree } from '../lib/types.js';

/**
 * In-app span waterfall rendered from the locally stored trace metadata
 * (no OTel backend needed). Each span is a duration bar, color-coded by type:
 * chat = blue, execute_tool = orange, error = red, root = slate.
 */
function spanColor(span: SpanMeta): string {
  if (span.status === 'error') return 'bg-red-500';
  if (span.type === 'chat') return 'bg-blue-500';
  if (span.type === 'execute_tool') return 'bg-orange-500';
  if (span.type === 'root') return 'bg-slate-400';
  return 'bg-slate-300';
}

function label(span: SpanMeta): string {
  if (span.type === 'execute_tool') {
    return String(span.attributes['gen_ai.tool.name'] ?? span.name);
  }
  return span.name;
}

export function TraceWaterfall({ trace }: { trace: TraceTree | undefined }) {
  const spans = useMemo(() => {
    if (!trace?.spans.length) return [];
    const min = Math.min(...trace.spans.map((s) => s.startedAt));
    return trace.spans
      .map((s) => ({ ...s, offset: s.startedAt - min }))
      .sort((a, b) => a.startedAt - b.startedAt);
  }, [trace]);

  if (!trace) {
    return <div className="p-1 text-muted text-sm">No trace data available for this run.</div>;
  }
  if (trace.traceId == null) {
    return <div className="p-1 text-muted text-sm">Tracing was disabled for this run.</div>;
  }
  if (!spans.length) {
    return <div className="p-1 text-muted text-sm">No spans recorded.</div>;
  }

  const total = trace.totalDurationMs || Math.max(...spans.map((s) => s.offset + (s.durationMs ?? 0))) || 1;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-xs text-muted">
        <span>trace <code className="text-foreground">{trace.traceId}</code></span>
        <span>· {trace.spanCount} spans</span>
        <span>· {trace.errorCount} errors</span>
      </div>
      <div className="space-y-1">
        {spans.map((s) => {
          const dur = s.durationMs ?? 0;
          const leftPct = total > 0 ? (s.offset / total) * 100 : 0;
          const widthPct = total > 0 ? Math.max(0.5, (dur / total) * 100) : 1;
          return (
            <div key={s.spanId} className="flex items-center gap-2 text-xs">
              <div className="w-40 shrink-0 truncate text-muted" title={label(s)}>{label(s)}</div>
              <div className="relative flex-1 h-1 bg-muted/10 rounded">
                <div
                  className={`absolute h-1 rounded ${spanColor(s)}`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  title={`${label(s)} · ${dur}ms · ${s.status}`}
                />
              </div>
              <div className="w-20 shrink-0 text-right text-muted">{dur}ms</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
