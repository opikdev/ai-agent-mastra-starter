import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { onShutdown } from './platform/shutdown.ts';

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // With no metricReaders, NodeSDK also exports metrics over OTLP from the same OTEL_* settings.
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'ai-agent-mastra-starter',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [new PgInstrumentation({ requireParentSpan: true })],
  });
  sdk.start();
  onShutdown(() => sdk.shutdown());
}
