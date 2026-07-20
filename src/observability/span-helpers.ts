import { randomUUID } from 'node:crypto';
import { getCurrentSpan, runInSpan } from './span-context.js';
import type { TraceRecorder, SpanType } from './trace-meta.js';

export const MAX_ARG_CHARS = 2000;

/** Truncate a string to `max` chars with an ellipsis marker. */
export function truncate(s: string, max = MAX_ARG_CHARS): string {
  return s.length <= max ? s : s.slice(0, max) + '…[truncated]';
}

/** Whether full prompt/completion content should be captured into span attributes. */
export function captureContent(): boolean {
  return process.env.OTEL_CAPTURE_CONTENT === 'true';
}

/**
 * Run `fn` inside a span tracked by the local TraceRecorder. Each span gets
 * a crypto-random spanId. The traceId comes from the recorder. Parent-child
 * linking uses Node.js AsyncLocalStorage for automatic context propagation
 * across async boundaries — no OTel backend required.
 */
export async function withSpan<T>(
  name: string,
  type: SpanType,
  recorder: TraceRecorder,
  attributes: Record<string, unknown>,
  fn: (spanId: string) => Promise<T>,
): Promise<T> {
  const spanId = randomUUID();
  const parentSpan = getCurrentSpan();
  const parentSpanId = parentSpan?.spanId ?? null;
  recorder.recordNew(spanId, recorder.traceId, name, type, parentSpanId, attributes);
  return runInSpan({ spanId, parentSpanId }, () => (async () => {
    try {
      const result = await fn(spanId);
      recorder.endSpan(spanId, 'ok');
      return result;
    } catch (err) {
      recorder.endSpan(spanId, 'error');
      const msg = err instanceof Error ? err.message : String(err);
      recorder.addAttribute(spanId, 'error.message', msg);
      throw err;
    }
  })() as unknown) as Promise<T>;
}
