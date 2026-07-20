/**
 * Lightweight tracing config flags. The project no longer depends on the
 * OpenTelemetry SDK — all trace metadata is recorded locally via TraceRecorder
 * and surfaced in the in-app Observability page + per-run TraceWaterfall.
 */

/** Whether local trace recording is enabled. Defaults to enabled. */
export function isTracingEnabled(): boolean {
  const v = process.env.OTEL_ENABLED;
  return v === undefined ? true : v === 'true';
}

/** Whether full prompt/completion content should be captured into span attributes. */
export function captureContent(): boolean {
  return process.env.OTEL_CAPTURE_CONTENT === 'true';
}
