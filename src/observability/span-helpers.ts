import { trace, context, type Span, type Tracer, type Attributes } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import type { TraceRecorder, SpanType } from './trace-meta.js';
import { captureContent } from './tracing.js';

export const MAX_ARG_CHARS = 2000;

/** Truncate a string to `max` chars with an ellipsis marker. */
export function truncate(s: string, max = MAX_ARG_CHARS): string {
  return s.length <= max ? s : s.slice(0, max) + '…[truncated]';
}

/** The spanId currently active in the OTel context, if any. */
function activeSpanId(): string | null {
  const s = trace.getSpan(context.active());
  return s?.spanContext()?.spanId ?? null;
}

export type SpanStatus = 'ok' | 'error' | 'unset';

/**
 * Run `fn` inside a new OTel span that is the active context for its duration.
 * The span is ended automatically (success => OK, throw => ERROR + recorded
 * exception). Metadata is mirrored into the local `TraceRecorder` so the
 * dashboard can reconstruct the tree without the OTel backend.
 *
 * Parent linking is automatic: the new span is a child of whatever span is
 * active when `withSpan` is called (OTel context propagation via async_hooks).
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  type: SpanType,
  recorder: TraceRecorder,
  attributes: Record<string, unknown>,
  fn: (span: Span, spanId: string) => Promise<T>,
): Promise<T> {
  const parentSpanId = activeSpanId();
  const span = tracer.startSpan(name, { attributes: attributes as Attributes });
  const spanId = span.spanContext().spanId;
  recorder.recordNew(spanId, span.spanContext().traceId, name, type, parentSpanId, attributes);
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span, spanId);
      recorder.endSpan(spanId, 'ok');
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      recorder.endSpan(spanId, 'error');
      const msg = err instanceof Error ? err.message : String(err);
      recorder.addAttribute(spanId, 'error.message', msg);
      span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

export { captureContent };
