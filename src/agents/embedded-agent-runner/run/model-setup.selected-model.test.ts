import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { Model } from "../../../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { writePersistedAuthProfileStoreRaw } from "../../auth-profiles/sqlite.js";
import { usesDedicatedBuiltinRuntime } from "../../builtin-runtime/selection.js";
import { resolveModelCandidateChain } from "../../model-fallback-candidates.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import { createEmptyAgentDiscoveryStores } from "../model.js";
import { prepareEmbeddedRunAuthPlan } from "./auth-plan.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import { resolveEmbeddedRunModelSetup } from "./model-setup.js";
import { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";
import { resolveInitialEmbeddedRunModel } from "./runtime-resolution.js";

const remoteConfig: OpenClawConfig = {
  agents: {
    defaults: {
      embeddedAgent: {
        runtimeServer: {
          url: "https://runtime.example.test",
          gatewayId: "test",
          tokenFile: "/test/token",
        },
      },
    },
  },
};

describe("dedicated runtime placement", () => {
  it.each([false, true])(
    "prepares model and auth without host credentials (builtin pin=%s)",
    async (pinned) => {
      await withOpenClawTestState(
        { label: "dedicated-prepare", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
        async (state) => {
          const model: Model = {
            provider: "openai",
            id: "remote-model",
            name: "Remote model",
            api: "openai-responses",
            baseUrl: "https://example.test/v1",
            input: ["text"],
            reasoning: false,
            contextWindow: 32000,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
          const config = remoteConfig;
          const createStores = vi.fn(() => {
            throw new Error("borrowed host credentials");
          });
          const snapshot: PreparedModelRuntimeSnapshot = {
            catalogOwner: undefined,
            agentId: "main",
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            activeProjectKeys: [],
            config,
            observationConfig: config,
            isCurrent: () => true,
            authModes: {},
            metadataSnapshot: createPluginMetadataSnapshotFixture(),
            pluginRegistry: createEmptyPluginRegistry(),
            allowGatewaySubagentBinding: false,
            modelCatalog: { entries: [], routeVariants: [] },
            inlineProviderModels: [],
            configuredRuntimeModels: [{ provider: model.provider, modelId: model.id, model }],
            createStores,
          };
          await withPluginRuntimeGenerationScope(snapshot, async () => {
            const runtime = await prepareEmbeddedRunRuntime({
              runParams: {
                config,
                agentId: "main",
                sessionId: "remote-prepare",
                runId: "remote-prepare",
                admittedRunContext: createTestAdmittedRunContext("remote-prepare"),
                workspaceDir: state.workspaceDir,
                prompt: "hello",
                timeoutMs: 1000,
              },
              sessionAdmission: pinned
                ? {
                    agentId: "main",
                    sessionKey: "agent:main:remote",
                    storePath: state.agentDir() + "/sessions.sqlite",
                    entry: {
                      sessionId: "remote-prepare",
                      updatedAt: 1,
                      modelSelectionLocked: true,
                      agentHarnessId: "openclaw",
                    },
                  }
                : undefined,
              provider: model.provider,
              modelId: model.id,
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
              globalLane: "test",
              hookRunner: undefined,
              hookContext: { sessionId: "remote-prepare", workspaceDir: state.workspaceDir },
              markStartupStage: () => {},
              notifyExecutionPhase: () => {},
              fallbackConfigured: false,
              preparedModelRuntime: snapshot,
            });
            expect(runtime.snapshot().agentHarness.id).toBe("openclaw");
            expect(runtime.getApiKeyInfo()).toBeNull();
            expect(runtime.authStorage.getAll()).toEqual({});
            expect(runtime.attemptAuthProfileStore.profiles).toEqual({});
            expect(
              runtime.snapshot().activePreparedAuthPlan.forwardedAuthProfileId,
            ).toBeUndefined();
            expect(await runtime.advanceAttemptAuthProfile()).toBe(false);
            expect(createStores).not.toHaveBeenCalled();
          });
        },
      );
    },
  );
  it("selects the built-in server without implicit account routing while preserving explicit harnesses", () => {
    expect(usesDedicatedBuiltinRuntime({ config: remoteConfig }, "openai", "fixture")).toBe(true);
    expect(
      usesDedicatedBuiltinRuntime(
        { config: remoteConfig, agentHarnessId: "codex" },
        "openai",
        "fixture",
      ),
    ).toBe(false);
    expect(usesDedicatedBuiltinRuntime({ config: {} }, "openai", "fixture")).toBe(false);
    expect(
      usesDedicatedBuiltinRuntime(
        {
          config: {
            ...remoteConfig,
            models: {
              providers: {
                custom: {
                  baseUrl: "https://example.test",
                  models: [],
                  agentRuntime: { id: "external" },
                },
              },
            },
          },
        },
        "custom",
        "fixture",
      ),
    ).toBe(false);
  });
});

const provider = "first-selected";
const otherProvider = "hook-selected";
const cases = [
  { name: "configured default", input: {}, planned: "middle", expected: "middle" },
  {
    name: "unmarked raw entry",
    input: { provider, model: "entry" },
    planned: "middle",
    expected: "middle",
  },
  {
    name: "marked raw entry",
    input: { provider, model: "entry", requestedRouteResolution: "raw" },
    planned: "middle",
    expected: "middle",
  },
  {
    name: "raw middle alias",
    input: { provider, model: "middle" },
    planned: "final",
    expected: "final",
  },
  {
    name: "selected middle",
    input: { provider, model: "middle", requestedRouteResolution: "resolved" },
    planned: "middle",
    expected: "middle",
  },
  {
    name: "selected model hook redirect",
    input: { provider, model: "middle", requestedRouteResolution: "resolved" },
    hook: { modelOverride: "entry" },
    planned: "middle",
    expected: "middle",
  },
  {
    name: "selected provider hook redirect",
    input: { provider, model: "middle", requestedRouteResolution: "resolved" },
    hook: { providerOverride: otherProvider },
    planned: "middle",
    expected: "other-final",
  },
  {
    name: "locked selection ignores hook",
    input: {
      provider,
      model: "middle",
      requestedRouteResolution: "resolved",
      modelSelectionLocked: true,
    },
    hook: { modelOverride: "entry" },
    planned: "middle",
    expected: "middle",
  },
  {
    name: "raw plain control",
    input: { provider, model: "plain" },
    planned: "plain",
    expected: "plain",
  },
  {
    name: "selected plain control",
    input: { provider, model: "plain", requestedRouteResolution: "resolved" },
    planned: "plain",
    expected: "plain",
  },
] as const;

describe.each(["registry", "prepared static"] as const)("initial model setup using %s", (tier) => {
  it.each(cases)("preserves $name through materialization", async (scenario) => {
    await withOpenClawTestState(
      { label: "initial-model-selection", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const config: OpenClawConfig = {
          agents: { defaults: { workspace: state.workspaceDir, model: `${provider}/entry` } },
        };
        writePersistedAuthProfileStoreRaw(
          {
            version: 1,
            profiles: Object.fromEntries(
              [provider, otherProvider].map((id) => [
                `${id}:fixture`,
                { type: "api_key" as const, provider: id, key: "synthetic-fixture" },
              ]),
            ),
          },
          state.agentDir(),
        );
        const metadataSnapshot = createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: provider,
              providers: [provider, otherProvider],
              modelIdNormalization: {
                providers: {
                  [provider]: { aliases: { entry: "middle", middle: "final" } },
                  [otherProvider]: { aliases: { middle: "other-final" } },
                },
              },
            },
          ],
        });
        const createModel = (modelProvider: string, id: string) =>
          ({
            provider: modelProvider,
            id,
            name: id,
            api: "openai-completions",
            baseUrl: "https://initial-model.example/v1",
            input: ["text"],
            reasoning: false,
            contextWindow: 32000,
            maxTokens: 256,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }) satisfies Model;
        const models = ["middle", "final", "plain"].map((id) => createModel(provider, id));
        const otherModels = [createModel(otherProvider, "other-final")];
        const stores = createEmptyAgentDiscoveryStores();
        if (tier === "registry") {
          stores.modelRegistry.registerProvider(provider, {
            api: "openai-completions",
            baseUrl: "https://initial-model.example/v1",
            models,
          });
          stores.modelRegistry.registerProvider(otherProvider, {
            api: "openai-completions",
            baseUrl: "https://initial-model.example/v1",
            models: otherModels,
          });
        }
        const snapshot: PreparedModelRuntimeSnapshot = {
          catalogOwner: undefined,
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          activeProjectKeys: [],
          config,
          observationConfig: config,
          isCurrent: () => true,
          authModes: {},
          metadataSnapshot,
          pluginRegistry: createEmptyPluginRegistry(),
          allowGatewaySubagentBinding: false,
          modelCatalog: { entries: [], routeVariants: [] },
          inlineProviderModels: [],
          configuredRuntimeModels:
            tier === "prepared static"
              ? [...models, ...otherModels].map((model) => ({
                  provider: model.provider,
                  modelId: model.id,
                  model,
                }))
              : [],
          createStores: () => stores,
        };
        await withPluginRuntimeGenerationScope(snapshot, async () => {
          const runParams: RunEmbeddedAgentInternalParams = {
            config,
            agentId: "main",
            sessionId: "initial-model-selection",
            runId: "initial-model-selection",
            workspaceDir: state.workspaceDir,
            prompt: "Synthetic model selection",
            timeoutMs: 1000,
            agentHarnessId: "openclaw",
            ...scenario.input,
          };
          const initial = resolveInitialEmbeddedRunModel({
            ...runParams,
            config: runParams.config,
          });
          const planned = resolveModelCandidateChain({
            cfg: config,
            agentId: "main",
            provider: initial.provider,
            model: initial.modelId,
            requestedRouteResolution: runParams.requestedRouteResolution,
            fallbacksOverride: [],
            manifestPlugins: metadataSnapshot,
          });
          expect(planned[0]?.model).toBe(scenario.planned);
          const hook = "hook" in scenario ? scenario.hook : undefined;
          const setup = await resolveEmbeddedRunModelSetup({
            runParams,
            ...initial,
            agentDir: snapshot.agentDir,
            workspaceDir: state.workspaceDir,
            globalLane: "test",
            hookRunner: hook
              ? { hasHooks: () => true, runBeforeModelResolve: async () => hook }
              : undefined,
            hookContext: { sessionId: runParams.sessionId, workspaceDir: state.workspaceDir },
            onHooksResolved: () => {},
            preparedModelRuntime: snapshot,
          });
          const requestedModelId =
            hook && "modelOverride" in hook && runParams.modelSelectionLocked !== true
              ? hook.modelOverride
              : initial.modelId;
          expect(setup.requestedModelId).toBe(requestedModelId);
          expect(setup.model.id).toBe(scenario.expected);
          let currentModel = setup.model;
          let harness = setup.agentHarness;
          const auth = await prepareEmbeddedRunAuthPlan({
            runParams,
            provider: setup.provider,
            modelId: setup.modelId,
            model: setup.model,
            agentDir: snapshot.agentDir,
            workspaceDir: state.workspaceDir,
            nativeModelOwned: false,
            authStorage: setup.authStorage,
            modelRegistry: setup.modelRegistry,
            preparedModelRuntime: snapshot,
            getAgentHarness: () => harness,
            setAgentHarness: (next) => {
              harness = next;
            },
            getRuntimeModel: () => currentModel,
            getEffectiveModel: () => currentModel,
            applyResolvedRuntimeModel: (next) => {
              currentModel = next;
            },
            selectHarnessForPreparedAttempts: () => harness,
          });
          const rematerialized = await auth.materializeAuthPlanUncached(
            auth.activePreparedAuthPlan,
            true,
          );
          expect(setup.modelId).toBe(scenario.expected);
          expect(rematerialized?.id).toBe(scenario.expected);
        });
      },
    );
  });
});
