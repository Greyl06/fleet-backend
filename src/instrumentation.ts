import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { config } from "./config/env.js";

function traceExporter() {
  if (!config.otelEndpoint) return undefined;
  const baseUrl = config.otelEndpoint.replace(/\/+$/, "");
  return new OTLPTraceExporter({
    url: baseUrl.endsWith("/v1/traces")
      ? baseUrl
      : `${baseUrl}/v1/traces`,
  });
}

export const telemetrySdk = new NodeSDK({
  resource: resourceFromAttributes({
    "service.name": config.otelServiceName,
    "deployment.environment.name": config.env,
  }),
  traceExporter: traceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
});

telemetrySdk.start();
