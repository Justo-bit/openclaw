import { expectDefined } from "@openclaw/normalization-core";
import type { DiagnosticEventPrivateData } from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  OpenClawPluginServiceContext,
} from "../api.js";
import { createDiagnosticsPrometheusExporter } from "./service.js";

export const trusted: DiagnosticEventMetadata = Object.freeze({ trusted: true });

type TrustedExporterInternalDiagnostics = NonNullable<
  OpenClawPluginServiceContext["internalDiagnostics"]
> & {
  reportExporterHealth?: (update: {
    signal: "metrics";
    transport: "prometheus-scrape";
    status: "started" | "dropped";
    reason?: "configured";
  }) => void;
};

export function baseEvent(): Pick<DiagnosticEventPayload, "seq" | "ts"> {
  return { seq: 1, ts: 1700000000000 };
}

export function createMetricsHarness() {
  const exporter = createDiagnosticsPrometheusExporter();
  let listener:
    | ((
        event: DiagnosticEventPayload,
        metadata: DiagnosticEventMetadata,
        privateData: DiagnosticEventPrivateData,
      ) => void)
    | undefined;
  exporter.service.start({
    config: {} as never,
    stateDir: "/tmp/openclaw-prometheus-test",
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    internalDiagnostics: {
      emit() {},
      onEvent(nextListener) {
        listener = nextListener;
        return () => {
          listener = undefined;
        };
      },
      reportExporterHealth() {},
    } as TrustedExporterInternalDiagnostics,
  });
  return {
    handler: exporter.handler,
    record(event: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) {
      expectDefined(listener, "Prometheus diagnostics listener")(event, metadata, {});
    },
    stop: () => exporter.service.stop?.(),
  };
}
