import fs from 'node:fs';
import path from 'node:path';

/**
 * Lightweight, locally-stored mirror of a run's trace tree. This is *not* a
 * replacement for the OTel backend — it only holds enough span metadata
 * (ids, types, durations, statuses, key attributes) for the dashboard to
 * render an in-app waterfall and record span metadata locally.
 */

export type SpanType = 'root' | 'chat' | 'execute_tool' | 'other';

export interface SpanEvent {
  name: string;
  timeMs: number;
  attributes?: Record<string, unknown>;
}

export interface SpanMeta {
  spanId: string;
  parentSpanId: string | null;
  traceId: string;
  name: string;
  type: SpanType;
  startedAt: number; // epoch ms
  endedAt: number | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'unset';
  attributes: Record<string, unknown>;
  events: SpanEvent[];
}

export interface TraceMeta {
  traceId: string;
  runId: string;
  model: string;
  scenario: string;
  modelConfig: string;
  spans: SpanMeta[];
  totalDurationMs: number;
  spanCount: number;
  errorCount: number;
  externalUrl: string | null;
  capturedAt: string;
}

/** Lightweight summary persisted to `index.json` next to each run. */
export interface TraceIndexSummary {
  trace_id: string;
  span_count: number;
  total_duration_ms: number;
  error_count: number;
  external_url: string | null;
  model: string;
  runId: string;
}

/**
 * Accumulates span metadata for a single run. The agent-loop instrumentation
 * records into it as spans are created/ended; on run completion it is flushed
 * to `outputs/<model>/<runId>/trace-meta.json` (+ `index.json` summary).
 */
export class TraceRecorder {
  readonly traceId: string;
  readonly runId: string;
  readonly model: string;
  readonly scenario: string;
  readonly modelConfig: string;
  private readonly spans = new Map<string, SpanMeta>();
  private readonly rootStart: number;

  constructor(opts: {
    traceId: string;
    runId: string;
    model: string;
    scenario: string;
    modelConfig: string;
  }) {
    this.traceId = opts.traceId;
    this.runId = opts.runId;
    this.model = opts.model;
    this.scenario = opts.scenario;
    this.modelConfig = opts.modelConfig;
    this.rootStart = Date.now();
  }

  record(span: SpanMeta): void {
    this.spans.set(span.spanId, span);
  }

  recordNew(spanId: string, traceId: string, name: string, type: SpanType, parentSpanId: string | null, attributes?: Record<string, unknown>): void {
    this.spans.set(spanId, {
      spanId,
      parentSpanId,
      traceId,
      name,
      type,
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      status: 'unset',
      attributes: { ...(attributes ?? {}) },
      events: [],
    });
  }

  getSpan(spanId: string): SpanMeta | undefined {
    return this.spans.get(spanId);
  }

  endSpan(spanId: string, status: 'ok' | 'error' | 'unset' = 'unset'): void {
    const s = this.spans.get(spanId);
    if (!s) return;
    s.endedAt = Date.now();
    s.durationMs = s.endedAt - s.startedAt;
    s.status = status;
  }

  addAttribute(spanId: string, key: string, value: unknown): void {
    const s = this.spans.get(spanId);
    if (!s) return;
    s.attributes[key] = value;
  }

  addEvent(spanId: string, name: string, attributes?: Record<string, unknown>): void {
    const s = this.spans.get(spanId);
    if (!s) return;
    s.events.push({ name, timeMs: Date.now(), attributes });
  }

  toMeta(externalUrl: string | null): TraceMeta {
    const spans = [...this.spans.values()].sort((a, b) => a.startedAt - b.startedAt);
    const totalDurationMs = Date.now() - this.rootStart;
    const errorCount = spans.filter((s) => s.status === 'error').length;
    return {
      traceId: this.traceId,
      runId: this.runId,
      model: this.model,
      scenario: this.scenario,
      modelConfig: this.modelConfig,
      spans,
      totalDurationMs,
      spanCount: spans.length,
      errorCount,
      externalUrl,
      capturedAt: new Date().toISOString(),
    };
  }
}

/** Persist full trace metadata + the lightweight index summary. */
export function writeTraceMeta(outputDir: string, meta: TraceMeta): void {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'trace-meta.json'), JSON.stringify(meta, null, 2));
  const summary: TraceIndexSummary = {
    trace_id: meta.traceId,
    span_count: meta.spanCount,
    total_duration_ms: meta.totalDurationMs,
    error_count: meta.errorCount,
    external_url: meta.externalUrl,
    model: meta.model,
    runId: meta.runId,
  };
  fs.writeFileSync(path.join(outputDir, 'index.json'), JSON.stringify(summary, null, 2));
}

/** Read a previously-persisted trace metadata file for a run output dir. */
export function readTraceMeta(outputDir: string): TraceMeta | null {
  const p = path.join(outputDir, 'trace-meta.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as TraceMeta;
  } catch {
    return null;
  }
}

/** Read the lightweight trace index summary for a run output dir. */
export function readTraceIndex(outputDir: string): TraceIndexSummary | null {
  const p = path.join(outputDir, 'index.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as TraceIndexSummary;
  } catch {
    return null;
  }
}
