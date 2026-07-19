import 'dotenv/config';
import { trace, type Tracer } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { createLogger } from '../logger/pino-logger.js';

const logger = createLogger('ai-arena:otel');

let started = false;
let sdk: NodeSDK | null = null;

/** Whether OpenTelemetry tracing is enabled. Defaults to enabled. */
export function isTracingEnabled(): boolean {
  const v = process.env.OTEL_ENABLED;
  return v === undefined ? true : v === 'true';
}

/** Whether full prompt/completion content should be captured into span attributes. */
export function captureContent(): boolean {
  return process.env.OTEL_CAPTURE_CONTENT === 'true';
}

/** Base URL of the external trace UI (Jaeger/Grafana), without a trailing slash. */
export function traceUiBaseUrl(): string {
  return (process.env.OTEL_TRACE_UI_BASE_URL ?? '').replace(/\/+$/, '');
}

/** Configured OTLP exporter endpoint, if any. */
export function exporterEndpoint(): string | undefined {
  return process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}

/** Build the external trace URL for a given trace id, if a UI base is configured. */
export function externalTraceUrl(traceId: string): string | null {
  const base = traceUiBaseUrl();
  if (!base) return null;
  return `${base}/trace/${traceId}`;
}

export function serviceName(): string {
  return process.env.OTEL_SERVICE_NAME ?? 'ai-model-arena';
}

/**
 * Initialise the OpenTelemetry SDK for this process. Idempotent. When
 * `OTEL_ENABLED=false`, this is a no-op and `getTracer()` returns the global
 * no-op tracer. The OTLP exporter reads `OTEL_EXPORTER_OTLP_ENDPOINT` from the
 * environment automatically, so traces ship to any OTel-compatible backend.
 */
export function initTracing(): void {
  if (started) return;
  started = true;
  if (!isTracingEnabled()) {
    logger.info('OpenTelemetry tracing disabled (OTEL_ENABLED=false)');
    return;
  }
  try {
    const resource = resourceFromAttributes({
      'service.name': serviceName(),
      'service.version': '0.1.0',
    });
    const traceExporter = new OTLPTraceExporter();
    sdk = new NodeSDK({ traceExporter, resource });
    sdk.start();
    logger.info('OpenTelemetry tracing started', {
      endpoint: exporterEndpoint() ?? '(default http://localhost:4318/v1/traces)',
      captureContent: captureContent(),
    });
  } catch (err) {
    logger.warn('Failed to start OpenTelemetry SDK, tracing disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
    sdk = null;
  }
}

/** Get a tracer. Before/without SDK start this returns the global no-op tracer. */
export function getTracer(name = 'ai-model-arena'): Tracer {
  return trace.getTracer(name);
}

/** Flush + shut down the SDK (best-effort). Safe to call at process exit. */
export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
    logger.info('OpenTelemetry SDK shut down');
  } catch (err) {
    logger.warn('Error shutting down OpenTelemetry', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    sdk = null;
  }
}
