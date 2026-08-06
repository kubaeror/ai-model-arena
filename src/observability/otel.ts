import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { AlwaysOnSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

let sdk: NodeSDK | null = null;

export function startOtel(): void {
  if (sdk) return;
  const enabled = process.env.OTEL_ENABLED !== 'false';
  if (!enabled) return;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;

  const samplingRatio = parseFloat(process.env.OTEL_SAMPLING_RATIO ?? '1.0');
  const sampler = samplingRatio >= 1.0 ? new AlwaysOnSampler() : new TraceIdRatioBasedSampler(samplingRatio);

  const exporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'ai-arena-runner' }),
    traceExporter: exporter,
    sampler,
    instrumentations: [new HttpInstrumentation()],
  });
  sdk.start();
}

export async function shutdownOtel(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
  }
}
