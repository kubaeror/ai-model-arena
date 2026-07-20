import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Minimal AsyncLocalStorage-based span context propagation, replacing the
 * OpenTelemetry SDK's async_hooks-based context. Only stores the current
 * spanId + parentSpanId so TraceRecorder can reconstruct the span tree
 * without an OTel backend.
 */

interface SpanState {
  spanId: string;
  parentSpanId: string | null;
}

const storage = new AsyncLocalStorage<SpanState>();

export function getCurrentSpan(): SpanState | undefined {
  return storage.getStore();
}

export function runInSpan(state: SpanState, fn: () => unknown) {
  return storage.run(state, fn);
}
