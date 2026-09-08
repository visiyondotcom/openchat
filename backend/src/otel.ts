// Must be imported FIRST, before any other module (especially fastify/
// prisma/ioredis) — auto-instrumentation patches those modules' exports,
// which only works if it runs before anything else requires them. See
// index.ts's first import line.
//
// Entirely opt-in: with no OTEL_EXPORTER_OTLP_ENDPOINT set, this file
// still runs (so the import order requirement is satisfied either way)
// but starts nothing — zero overhead, zero external calls, for
// deployments that don't want OpenTelemetry at all.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  // The @opentelemetry/* sub-packages are versioned independently and
  // sdk-node bundles its own internal copies of sdk-metrics/resources —
  // this occasionally causes cross-package type friction (mismatched
  // private fields, renamed helpers) even when semver ranges are
  // satisfied. Since this whole block is optional instrumentation gated
  // behind OTEL_EXPORTER_OTLP_ENDPOINT, we build the config as `any` to
  // stay resilient to that drift rather than hard-failing the build.
  const resource = new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "visiyon-backend",
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "0.0.0",
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 15000,
    }) as any,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Fastify/HTTP/Prisma/ioredis/undici(fetch) spans are the useful
        // ones for this app; filesystem instrumentation is noisy (every
        // document upload read triggers dozens of spans) and adds little
        // value, so it's turned off.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  } as any);

  sdk.start();

  process.on("SIGTERM", () => {
    sdk.shutdown().finally(() => process.exit(0));
  });

  // eslint-disable-next-line no-console
  console.log(`[otel] tracing/metrics enabled, exporting to ${endpoint}`);
}
