import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * OTLP metrics export (per AGENTS.md: SDK → OTLP → Collector → Prometheus).
 * Runs alongside the prom-client scrape endpoint — the collector merges both
 * sources. No-op-safe: only starts when OTEL_EXPORTER_OTLP_ENDPOINT is set so
 * dev/test runs without a collector are unaffected.
 */
export function startOtelMetrics(serviceName: string): () => void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return () => undefined;
  try {
    const exporter = new OTLPMetricExporter({});
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 30_000 });
    const provider = new MeterProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
      readers: [reader],
    });
    return () => {
      void provider.shutdown().catch(() => undefined);
    };
  } catch (err) {
    // Never take the process down because metrics export misconfigured.
    process.emitWarning(`startOtelMetrics failed for ${serviceName}: ${String(err)}`);
    return () => undefined;
  }
}
