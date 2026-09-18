import fs from "node:fs";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { writePersistedAuthProfileStoreRaw } from "../auth-profiles/sqlite.js";
import * as builtinSelection from "../builtin-runtime/selection.js";
import { FailoverError } from "../failover-error.js";
import * as harnessRuntimes from "../harness-runtimes.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { runWithModelFallback } from "../model-fallback-runner.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import { SessionManager } from "../sessions/session-manager.js";
import { immediateEnqueue } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { runEmbeddedAgent } from "./run-orchestrator.js";
import { prepareEmbeddedRunRuntime } from "./run/runtime-preparation.js";

// Keep actual admission, candidate planning, plugin loading, snapshots and model/auth preparation.
// Only stop before inference; the fallback runner observes a real classified primary failure.
const loop = vi.hoisted(() => vi.fn<(typeof import("./run-loop.js"))["runPreparedEmbeddedLoop"]>());
vi.mock("./run-loop.js", () => ({ runPreparedEmbeddedLoop: loop }));

it.each(["model", "provider"] as const)(
  "prepares a dedicated primary and selection-activated %s-policy fallback with separate credentials",
  async (policyScope) => {
    const state = await createOpenClawTestState({
      label: "mixed-runtime-placement",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    });
    let admission: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
    // Isolate the selected-candidate path from config-wide startup preloading: only
    // the actual candidate selection may activate this real plugin fixture.
    const configuredRuntimes = vi
      .spyOn(harnessRuntimes, "collectConfiguredAgentHarnessRuntimes")
      .mockReturnValue([]);
    try {
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            "fallback-fixture:test": {
              type: "api_key",
              provider: "fallback-fixture",
              key: "synthetic-fallback-credential",
            },
          },
        },
        state.agentDir(),
      );
      const pluginRoot = state.path("external-harness");
      fs.mkdirSync(pluginRoot);
      const fixture = createColdPluginFixture({
        rootDir: pluginRoot,
        pluginId: "fallback-harness",
        manifest: {
          providers: [],
          channels: [],
          providerAuthChoices: [],
          activation: { onStartup: false, onAgentHarnesses: ["external-fixture"] },
        },
      });
      fs.writeFileSync(
        fixture.runtimeSource,
        'module.exports = { id: "fallback-harness", register(api) { api.registerAgentHarness({ id: "external-fixture", label: "External fixture", authBootstrap: "host", supports: () => ({ supported: true }), runAttempt: async () => { throw new Error("inference not expected"); } }); } };',
      );
      const model = {
        id: "model",
        name: "Synthetic model",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 1024,
      };
      const config: OpenClawConfig = {
        agents: {
          entries: { main: { default: true, workspace: state.workspaceDir } },
          defaults: {
            workspace: state.workspaceDir,
            model: { primary: "dedicated-fixture/model", fallbacks: ["fallback-fixture/model"] },
            ...(policyScope === "model"
              ? {
                  models: {
                    "fallback-fixture/model": { agentRuntime: { id: "external-fixture" } },
                  },
                }
              : {}),
            embeddedAgent: {
              runtimeServer: {
                url: "ws://127.0.0.1:9/runtime",
                gatewayId: "fixture",
                tokenFile: state.path("unused-token"),
              },
            },
          },
        },
        models: {
          providers: {
            "dedicated-fixture": {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [model],
            },
            "fallback-fixture": {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [model],
              ...(policyScope === "provider" ? { agentRuntime: { id: "external-fixture" } } : {}),
            },
          },
        },
        plugins: {
          allow: [fixture.pluginId],
          load: { paths: [fixture.rootDir] },
          slots: { memory: "none" },
        },
      };
      let primarySnapshot: PreparedModelRuntimeSnapshot | undefined;
      const prepared: string[] = [];
      loop.mockImplementation(async (_refresh, input) => {
        const snapshot = input.preparedModelRuntime!;
        // The fallback owner must already be registered in primary preparation, not only
        // after a second selection incidentally loads it.
        await ensureSelectedAgentHarnessPlugin({
          config,
          agentId: "main",
          provider: "fallback-fixture",
          modelId: "model",
          workspaceDir: state.workspaceDir,
          pluginRegistry: snapshot.pluginRegistry,
        });
        const runtime = await prepareEmbeddedRunRuntime({
          ...input,
          markStartupStage: () => {},
          notifyExecutionPhase: () => {},
        });
        try {
          prepared.push(runtime.snapshot().agentHarness.id);
          if (input.provider === "dedicated-fixture") {
            primarySnapshot = snapshot;
            expect(snapshot.createStores().authStorage.getAll()).toEqual({});
            expect(snapshot.authModes).toEqual({});
            expect(runtime.getApiKeyInfo()).toBeNull();
            expect(runtime.attemptAuthProfileStore.profiles).toEqual({});
            // The outer candidate search consumes the still-owned prepared registry.
            const fallback = await runWithModelFallback({
              cfg: config,
              provider: input.provider,
              model: input.modelId,
              agentId: "main",
              agentDir: state.agentDir(),
              manifestPlugins: snapshot.metadataSnapshot,
              skipAuthProfileRuntime: true,
              run: (provider, candidateModel) => {
                if (provider === "dedicated-fixture") {
                  throw new FailoverError("Synthetic primary unavailable", {
                    reason: "model_not_found",
                    provider,
                    model: candidateModel,
                  });
                }
                return runCandidate(provider, candidateModel);
              },
            });
            expect(fallback.provider).toBe("fallback-fixture");
            return fallback.result;
          }
          expect(snapshot).not.toBe(primarySnapshot);
          expect(runtime.snapshot().agentHarness.id).toBe("external-fixture");
          expect(runtime.getApiKeyInfo()?.apiKey).toBe("synthetic-fallback-credential");
          expect(snapshot.authModes["fallback-fixture"]).toBe("api_key");
          return { payloads: [{ text: "fallback prepared" }], meta: { durationMs: 1 } };
        } finally {
          runtime.stopRuntimeAuthRefreshTimer();
        }
      });
      const runId = "mixed-placement-" + policyScope;
      admission = prepareSystemAgentRunAdmission(config, runId, "main", "mixed-placement-test");
      const runCandidate = (provider: string, candidateModel: string) =>
        runEmbeddedAgent({
          config,
          provider,
          model: candidateModel,
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          sessionId: runId,
          sessionKey: "agent:main:" + runId,
          runId,
          prompt: "Prepare the selected candidate",
          timeoutMs: 5000,
          enqueue: immediateEnqueue,
          preparedRunAdmission: admission,
          preparedModelRuntimeMode: "isolated-read-only",
          sessionPersistence: "detached",
          sessionManager: SessionManager.inMemory(state.workspaceDir),
        });
      // Negative control reproduces the former primary-wide placement stamp. The
      // real loader must reject the external fallback before we exercise the fix.
      const primaryWidePlacement = vi
        .spyOn(builtinSelection, "usesDedicatedBuiltinRuntime")
        .mockReturnValue(true);
      try {
        await expect(runCandidate("dedicated-fixture", "model")).rejects.toThrow(
          'Agent harness runtime "external-fixture" is unavailable',
        );
      } finally {
        primaryWidePlacement.mockRestore();
      }
      expect(prepared).toEqual([]);
      const result = await runCandidate("dedicated-fixture", "model");
      expect(result.payloads).toEqual([{ text: "fallback prepared" }]);
      expect(prepared).toEqual(["openclaw", "external-fixture"]);
    } finally {
      admission?.close();
      await resetPreparedModelRuntimeSnapshotsForTest();
      clearPluginMetadataLifecycleCaches();
      resetPluginLoaderTestStateForTest();
      loop.mockReset();
      configuredRuntimes.mockRestore();
      await state.cleanup();
    }
  },
);
