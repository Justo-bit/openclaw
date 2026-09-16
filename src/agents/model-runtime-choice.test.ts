import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../plugin-sdk/diagnostic-runtime.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { buildInlineProviderModels } from "./embedded-agent-runner/model.inline-provider.js";
import { prepareModelChoice, preparePublishedModelRuntimeChoice } from "./model-runtime-choice.js";
import {
  getPreparedModelRuntimeAuthStore,
  setPreparedModelRuntimeAuthStore,
} from "./prepared-model-runtime-auth.js";
import { prepareConfiguredModelAliases } from "./prepared-model-runtime.configured-completion.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";
import { buildConfiguredAgentSystemPrompt } from "./system-prompt-config.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";

const published = vi.hoisted((): { owner?: PreparedModelRuntimeSnapshot } => ({}));
vi.mock("./prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => published.owner,
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
  withPreparedModelCatalogOwner: async <T>(
    _params: unknown,
    read: (owner: PreparedModelRuntimeSnapshot) => T | Promise<T>,
  ) => {
    if (!published.owner) {
      throw new Error("No published test model owner");
    }
    return await read(published.owner);
  },
}));

const cfg: OpenClawConfig = { plugins: { enabled: false } };
const request = {
  cfg,
  agentId: "main",
  provider: "fixture",
  model: "model",
  runtimeId: "openclaw",
};

function publish(
  isCurrent = () => true,
  config = cfg,
  facts: Partial<
    Pick<
      PreparedModelRuntimeSnapshot,
      | "modelCatalog"
      | "configuredRuntimeModels"
      | "pluginRegistry"
      | "metadataSnapshot"
      | "agentDir"
      | "workspaceDir"
    >
  > = {},
  auth = true,
) {
  const entry = { provider: "fixture", id: "model", name: "Model" };
  const owner: PreparedModelRuntimeSnapshot = {
    config,
    observationConfig: config,
    catalogOwner: { agentId: "main", workspaceDir: facts.workspaceDir ?? "/tmp/runtime-choice" },
    agentId: "main",
    agentDir: "/tmp/runtime-choice/agent",
    workspaceDir: "/tmp/runtime-choice",
    activeProjectKeys: [],
    authModes: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    isCurrent,
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [entry], routeVariants: [entry] },
    configuredRuntimeModels: [],
    inlineProviderModels: buildInlineProviderModels(config.models?.providers ?? {}, {
      providerMetadataOwners: facts.metadataSnapshot?.owners,
    }),
    createStores() {
      const authStorage = AuthStorage.inMemory({});
      return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
    },
    ...facts,
  };
  if (auth) {
    setPreparedModelRuntimeAuthStore(owner, {
      version: 1,
      profiles: {
        "fixture:account": { type: "api_key", provider: "fixture", key: "synthetic-credential" },
      },
    });
  }
  published.owner = owner;
  return owner;
}

function renderPublishedAliases(owner: PreparedModelRuntimeSnapshot) {
  const authStore = getPreparedModelRuntimeAuthStore(owner);
  if (!authStore) {
    throw new Error("Expected prepared fixture accounts");
  }
  const { authStorage, modelRegistry } = owner.createStores();
  const configuredModelAliases = prepareConfiguredModelAliases(
    {
      input: {
        config: owner.config,
        agentId: owner.agentId,
        agentDir: owner.agentDir,
        workspaceDir: owner.workspaceDir,
      },
      env: {},
      authStore,
      templateAuthStorage: authStorage,
      credentials: {},
      providerIds: [...new Set(owner.configuredRuntimeModels.map(({ provider }) => provider))],
      configuredModelRefs: owner.configuredRuntimeModels.map(({ provider, modelId }) => ({
        provider,
        modelId,
      })),
      configuredRuntimeModels: owner.configuredRuntimeModels,
      runtimeCapabilityModels: [],
      configuredGeneratedCatalogPluginIds: [],
    },
    {
      pluginMetadataSnapshot: owner.metadataSnapshot,
      pluginRegistry: owner.pluginRegistry,
      inlineProviderModels: [],
      configuredCatalogEntries: owner.modelCatalog.entries,
    },
    modelRegistry,
    owner.configuredRuntimeModels,
  );
  return buildConfiguredAgentSystemPrompt({
    config: owner.config,
    agentId: owner.agentId,
    workspaceDir: owner.workspaceDir ?? "/tmp/runtime-choice",
    preparedModelRuntime: { ...owner, configuredModelAliases },
  });
}

describe("prepared model support admission", () => {
  const selection = { agentId: "main", raw: "fixture/new-model", source: "override" as const };
  const custom: OpenClawConfig = {
    ...cfg,
    models: {
      providers: {
        fixture: { api: "openai-completions", baseUrl: "https://custom.invalid/v1", models: [] },
      },
    },
  };

  it("uses the configured custom route outside the finite catalog", async () => {
    publish(() => true, custom);
    expect(await prepareModelChoice({ ...selection, cfg: custom })).toMatchObject({
      kind: "resolved",
      ref: { provider: "fixture", model: "new-model" },
      model: { id: "new-model", baseUrl: "https://custom.invalid/v1" },
    });
  });

  it("preserves an inherited model id that contains its provider prefix", async () => {
    publish(() => true, custom);
    const ref = { provider: "fixture", model: "fixture/custom-model" };
    expect(
      await prepareModelChoice({
        ...selection,
        cfg: custom,
        raw: "fixture/fixture/custom-model",
        source: "automatic",
        resolvedRef: ref,
      }),
    ).toMatchObject({ kind: "resolved", ref, model: { id: ref.model } });
  });

  it("keeps automatic defaults independent of manual override policy", async () => {
    const config: OpenClawConfig = {
      ...custom,
      agents: { defaults: { modelPolicy: { allow: ["fixture/manual-only"] } } },
    };
    publish(() => true, config);
    expect(await prepareModelChoice({ ...selection, cfg: config })).toMatchObject({
      kind: "unavailable",
      error: "model not allowed: fixture/new-model",
    });
    expect(
      await prepareModelChoice({ ...selection, cfg: config, source: "automatic" }),
    ).toMatchObject({ kind: "resolved" });
  });

  it.each(["override", "automatic"] as const)(
    "rejects an unsupported native %s selection before it can become a model",
    async (source) => {
      const config: OpenClawConfig = {
        ...cfg,
        models: {
          providers: {
            xai: { api: "openai-responses", baseUrl: "https://api.x.ai/v1", models: [] },
          },
        },
      };
      publish(() => true, config, {
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "xai",
              providers: ["xai"],
              providerEndpoints: [{ endpointClass: "xai-native", hosts: ["api.x.ai"] }],
            },
          ],
        }),
      });
      expect(
        await prepareModelChoice({
          ...selection,
          cfg: config,
          raw: "xai/nonexistent-native-fixture",
          source,
        }),
      ).toMatchObject({ kind: "unavailable", error: expect.stringContaining("Unknown model") });
    },
  );

  it("does not replace a missing pinned account with the available shared account", async () => {
    publish(() => true, custom);
    expect(
      await prepareModelChoice({ ...selection, cfg: custom, raw: "fixture/new-model@missing" }),
    ).toMatchObject({ kind: "unavailable", error: expect.stringContaining("selected account") });
  });

  it.each([
    { model: "current", ambiguous: false, admitted: true, authored: false, route: "native" },
    { model: "current", ambiguous: false, admitted: true, authored: true, route: "native" },
    { model: "unknown", ambiguous: false, admitted: false, authored: false, route: "native" },
    { model: "auto", ambiguous: false, admitted: false, authored: false, route: "native" },
    { model: "auto", ambiguous: false, admitted: false, authored: true, route: "native" },
    { model: "auto", ambiguous: false, admitted: true, authored: true, route: "custom" },
    { model: "auto", ambiguous: true, admitted: true, authored: true, route: "native" },
    { model: "private-model", ambiguous: false, admitted: true, authored: true, route: "native" },
    { model: "current", ambiguous: true, admitted: false, authored: false, route: "native" },
  ])(
    "checks the native donor before visible alias creation: $model/$ambiguous/$authored/$route",
    async (testCase) => {
      await withTestDir({ prefix: "openclaw-native-alias-" }, async (dir) => {
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { workspace: dir } },
            defaults: { modelPolicy: { allow: [] } },
          },
          session: { store: path.join(dir, "sessions.json") },
          models: {
            providers: {
              personal: {
                api: "openai-responses",
                baseUrl:
                  testCase.route === "custom" ? "https://custom.invalid/v1" : "https://api.x.ai/v1",
                models: testCase.authored
                  ? [
                      {
                        id: testCase.model,
                        name: "Authored model",
                        reasoning: false,
                        input: ["text"],
                        maxTokens: 4096,
                        compat: { codeMode: "capable" },
                        cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
                      },
                    ]
                  : [],
              },
            },
          },
        };
        const catalog = {
          api: "openai-responses" as const,
          baseUrl: "https://api.x.ai/v1",
          models: [
            { id: "current", name: "Current", compat: { codeMode: "preferred" as const } },
            { id: "auto", name: "Retired" },
          ],
        };
        const owner = publish(() => true, config, {
          agentDir: path.join(dir, "agent"),
          workspaceDir: dir,
          metadataSnapshot: createPluginMetadataSnapshotFixture({
            plugins: [
              {
                id: "xai",
                providers: ["xai"],
                providerEndpoints: [{ endpointClass: "xai-native", hosts: ["api.x.ai"] }],
                modelCatalog: {
                  discovery: { xai: "static" },
                  providers: { xai: catalog },
                  suppressions: [
                    {
                      provider: "xai",
                      model: "auto",
                      reason: "Retired selector",
                      retirement: { replacedBy: "current" },
                      when: { baseUrlHosts: ["api.x.ai"] },
                    },
                  ],
                },
              },
              ...(testCase.ambiguous
                ? [
                    {
                      id: "second-owner",
                      providers: ["second-native"],
                      modelCatalog: {
                        discovery: { "second-native": "static" as const },
                        providers: { "second-native": catalog },
                      },
                    },
                  ]
                : []),
            ],
          }),
        });
        setPreparedModelRuntimeAuthStore(owner, {
          version: 1,
          profiles: { personal: { provider: "personal", type: "api_key", key: "synthetic-key" } },
        });
        const callGateway = vi.fn(async () => {
          throw new Error("Reached session creation");
        });
        const tool = createSessionsSpawnTool({
          agentSessionKey: "agent:main:main",
          config,
          callGateway,
          registerRun: vi.fn(),
          countActiveRuns: () => 0,
        });
        const model = `personal/${testCase.model}`;
        if (testCase.authored && testCase.admitted) {
          expect(
            await prepareModelChoice({
              cfg: config,
              agentId: "main",
              raw: model,
              source: "override",
            }),
          ).toMatchObject({
            kind: "resolved",
            model: {
              compat: { codeMode: "capable" },
              cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
            },
          });
        }
        const result = tool.execute("native-alias", { task: "test", model, visible: true });
        if (testCase.admitted) {
          await expect(result).rejects.toThrow("Reached session creation");
          expect(callGateway).toHaveBeenCalledExactlyOnceWith(
            "sessions.create",
            expect.objectContaining({ model }),
          );
        } else {
          expect((await result).details).toMatchObject({ status: "error" });
          expect(callGateway).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each([
    { fallbacks: ["fixture/custom-unlisted"], kind: "automatic" },
    { fallbacks: ["xai/another-unsupported-model"], kind: "unavailable" },
  ])(
    "admits an automatic plan only with a viable candidate: $kind",
    async ({ fallbacks, kind }) => {
      const config: OpenClawConfig = {
        ...custom,
        models: {
          providers: {
            ...custom.models?.providers,
            xai: { api: "openai-responses", baseUrl: "https://api.x.ai/v1", models: [] },
          },
        },
      };
      publish(() => true, config, {
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "xai",
              providers: ["xai"],
              providerEndpoints: [{ endpointClass: "xai-native", hosts: ["api.x.ai"] }],
            },
          ],
        }),
      });
      const choice = await prepareModelChoice({
        ...selection,
        cfg: config,
        raw: "xai/nonexistent-native-fixture",
        source: "automatic",
        fallbacks,
      });
      expect(choice).toMatchObject(
        kind === "automatic"
          ? { kind, ref: { provider: "xai", model: "nonexistent-native-fixture" } }
          : { kind },
      );
      expect(
        await prepareModelChoice({
          ...selection,
          cfg: config,
          raw: "xai/nonexistent-native-fixture",
          source: "override",
          fallbacks,
        }),
      ).toMatchObject({ kind: "unavailable" });
    },
  );

  it("does not lend a native descriptor to another native endpoint", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: { api: "openai-responses", baseUrl: "https://b.native.invalid/v1", models: [] },
        },
      },
    };
    publish(() => true, config, {
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture",
            providers: ["fixture"],
            providerEndpoints: [
              { endpointClass: "xai-native", hosts: ["a.native.invalid"] },
              { endpointClass: "groq-native", hosts: ["b.native.invalid"] },
            ],
          },
        ],
      }),
      configuredRuntimeModels: [
        {
          provider: "fixture",
          modelId: "model",
          model: {
            provider: "fixture",
            id: "model",
            name: "Native A model",
            api: "openai-responses",
            baseUrl: "https://a.native.invalid/v1",
            reasoning: false,
            input: ["text"],
            contextWindow: 4096,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ],
    });
    expect(
      await prepareModelChoice({ ...selection, cfg: config, raw: "fixture/model" }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("does not advertise an inline model whose catalog alias has competing owners", async () => {
    const provider = "azure-openai-responses";
    const model = makeProviderModelFixture<"azure-openai-responses">({
      provider,
      id: "deployment",
      api: "azure-openai-responses",
      baseUrl: "https://example.openai.azure.com/openai/v1",
    });
    const config: OpenClawConfig = {
      plugins: { entries: { "workspace-override": { enabled: true } } },
      models: {
        providers: {
          [provider]: { api: "azure-openai-responses", baseUrl: model.baseUrl, models: [model] },
        },
      },
      agents: { defaults: { models: { [`${provider}/deployment`]: { alias: "Azure" } } } },
    };
    const owner = publish(() => true, config, {
      configuredRuntimeModels: [{ provider, modelId: model.id, model }],
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "openai",
            origin: "bundled",
            enabledByDefault: true,
            providers: ["openai"],
            modelCatalog: {
              aliases: { [provider]: { provider: "openai", api: "azure-openai-responses" } },
            },
          },
          {
            id: "workspace-override",
            origin: "workspace",
            providers: ["github-copilot"],
            modelCatalog: { aliases: { [provider]: { provider: "github-copilot" } } },
          },
        ],
      }),
    });
    const { withPluginRuntimeGenerationScope } =
      await import("../plugins/runtime/generation-scope.js");
    const { resolveManifestModelCatalogProviderAliasMetadata } =
      await import("./embedded-agent-runner/model.manifest-alias.js");
    expect(
      withPluginRuntimeGenerationScope(owner, () =>
        resolveManifestModelCatalogProviderAliasMetadata({
          provider,
          modelId: model.id,
          cfg: config,
        }),
      ),
    ).toMatchObject({ ambiguous: true });
    expect(
      await prepareModelChoice({
        ...selection,
        cfg: config,
        raw: `${provider}/deployment`,
        source: "automatic",
      }),
    ).toMatchObject({ kind: "unavailable" });
    expect(renderPublishedAliases(owner)).not.toContain(`- Azure: ${provider}/deployment`);
  });

  it("defers unobserved dynamic models but keeps known suppressions final", async () => {
    const config: OpenClawConfig = {};
    const dynamicModel = makeProviderModelFixture({
      provider: "fixture",
      id: "new-model",
      api: "openai-responses",
      baseUrl: "https://dynamic.invalid/v1",
    });
    const prepareDynamicModel = vi.fn(async () => dynamicModel);
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "fixture",
      source: "test",
      provider: {
        id: "fixture",
        label: "Fixture",
        auth: [],
        prepareDynamicModel,
      },
    });
    const owner = publish(() => true, config, {
      pluginRegistry: registry,
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture",
            providers: ["fixture"],
            modelCatalog: {
              suppressions: [
                { provider: "fixture", model: "retired", reason: "Retired fixture model" },
              ],
            },
          },
        ],
      }),
    });
    expect(
      await prepareModelChoice({ ...selection, cfg: config, source: "automatic" }),
    ).toMatchObject({
      kind: "pending",
      ref: { provider: "fixture", model: "new-model" },
    });
    expect(
      await prepareModelChoice({
        ...selection,
        cfg: config,
        source: "automatic",
        raw: "fixture/retired",
      }),
    ).toMatchObject({
      kind: "unavailable",
      error: expect.stringContaining("Retired fixture model"),
    });
    expect(prepareDynamicModel).not.toHaveBeenCalled();
    expect(await prepareModelChoice({ ...selection, cfg: config })).toMatchObject({
      kind: "resolved",
      ref: { provider: "fixture", model: "new-model" },
      model: dynamicModel,
    });
    expect(prepareDynamicModel).toHaveBeenCalledOnce();
    const incompleteConfig: OpenClawConfig = {
      models: {
        providers: {
          fixture: {
            baseUrl: "https://dynamic.invalid/v1",
            models: [
              {
                id: "retired",
                name: "Retired fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 1024,
              },
            ],
          },
        },
      },
    };
    publish(() => true, incompleteConfig, {
      pluginRegistry: registry,
      metadataSnapshot: owner.metadataSnapshot,
    });
    expect(
      await prepareModelChoice({
        ...selection,
        cfg: incompleteConfig,
        source: "automatic",
        raw: "fixture/retired",
      }),
    ).toMatchObject({
      kind: "unavailable",
      error: expect.stringContaining("Retired fixture model"),
    });
    expect(prepareDynamicModel).toHaveBeenCalledOnce();
  });

  function retiredXaiOwner(
    modelBaseUrl = "https://api.x.ai/v1",
    facts: Partial<
      Pick<PreparedModelRuntimeSnapshot, "pluginRegistry" | "agentDir" | "workspaceDir">
    > = {},
  ) {
    const model = makeProviderModelFixture<"openai-responses">({
      provider: "xai",
      id: "auto",
      api: "openai-responses",
      baseUrl: modelBaseUrl,
    });
    const config: OpenClawConfig = {
      ...custom,
      agents: { defaults: { models: { "xai/auto": { alias: "Grok" } } } },
      models: {
        providers: {
          ...custom.models?.providers,
          xai: { api: "openai-responses", baseUrl: "https://api.x.ai/v1", models: [model] },
        },
      },
    };
    return publish(() => true, config, {
      ...facts,
      configuredRuntimeModels: [{ provider: "xai", modelId: "auto", model }],
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "xai",
            providers: ["xai"],
            providerEndpoints: [{ endpointClass: "xai-native", hosts: ["api.x.ai"] }],
            modelCatalog: {
              suppressions: [
                {
                  provider: "xai",
                  model: "auto",
                  reason: "Retired native selector",
                  retirement: { replacedBy: "grok-4.6" },
                  when: { baseUrlHosts: ["api.x.ai"] },
                },
              ],
            },
          },
        ],
      }),
    });
  }

  it.each([
    { raw: "xai/auto", fallbacks: ["fixture/custom-unlisted"] },
    { raw: "xai/unsupported-primary", fallbacks: ["xai/auto", "fixture/custom-unlisted"] },
  ])("keeps a retired candidate local to the automatic plan: $raw", async ({ raw, fallbacks }) => {
    const owner = retiredXaiOwner();
    const ref = { provider: "xai", model: raw.slice("xai/".length) };
    expect(
      await prepareModelChoice({
        ...selection,
        cfg: owner.config,
        raw,
        source: "automatic",
        fallbacks,
      }),
    ).toMatchObject({ kind: "automatic", ref });
    expect(
      await prepareModelChoice({
        ...selection,
        cfg: owner.config,
        raw,
        source: "automatic",
        fallbacks: ["xai/auto"],
      }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("admits a visible spawn past a retired runtime-preferred fallback", async () => {
    await withTestDir({ prefix: "openclaw-retired-spawn-fallback-" }, async (dir) => {
      const registry = createEmptyPluginRegistry();
      registry.providers.push({
        pluginId: "xai",
        source: "test",
        provider: {
          id: "xai",
          label: "Fixture",
          auth: [],
          preferRuntimeResolvedModel: ({ modelId }) => modelId === "auto",
          resolveDynamicModel: ({ modelId }) =>
            modelId === "auto"
              ? makeProviderModelFixture({
                  provider: "xai",
                  id: modelId,
                  api: "openai-responses",
                  baseUrl: "https://api.x.ai/v1",
                })
              : undefined,
        },
      });
      const owner = retiredXaiOwner(undefined, {
        pluginRegistry: registry,
        agentDir: path.join(dir, "agent"),
        workspaceDir: dir,
      });
      const config = owner.config;
      config.session = { store: path.join(dir, "sessions.json") };
      config.agents = {
        entries: { main: { workspace: dir } },
        defaults: {
          modelPolicy: { allow: [] },
          subagents: {
            model: { primary: "xai/unknown-primary", fallbacks: ["xai/auto", "fixture/custom"] },
          },
        },
      };
      const callGateway = vi.fn(async () => {
        throw new Error("Reached session creation");
      });
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        config,
        callGateway,
        registerRun: vi.fn(),
        countActiveRuns: () => 0,
      });
      await expect(
        tool.execute("retired-fallback", { task: "test", visible: true }),
      ).rejects.toThrow("Reached session creation");
      expect(callGateway).toHaveBeenCalledExactlyOnceWith(
        "sessions.create",
        expect.objectContaining({ model: "xai/unknown-primary" }),
      );
    });
  });

  it.each([
    { baseUrl: "https://api.x.ai/v1", kind: "unavailable", advertised: false },
    { baseUrl: "https://custom.invalid/v1", kind: "resolved", advertised: true },
  ])(
    "uses final inline transport for admission and alias publication: $baseUrl",
    async ({ baseUrl, kind, advertised }) => {
      const owner = retiredXaiOwner(baseUrl);
      expect(
        await prepareModelChoice({ ...selection, cfg: owner.config, raw: "xai/auto" }),
      ).toMatchObject({ kind });
      expect(renderPublishedAliases(owner).includes("- Grok: xai/auto")).toBe(advertised);
    },
  );

  it("uses provider transport normalization for explicit, automatic and published aliases without discovery", async () => {
    const model = makeProviderModelFixture({
      provider: "xai",
      id: "grok-4.6",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
    const config: OpenClawConfig = {
      agents: { defaults: { models: { "xai/grok-4.6": { alias: "Grok" } } } },
      models: {
        providers: { xai: { api: "openai-completions", baseUrl: model.baseUrl, models: [] } },
      },
    };
    const registry = createEmptyPluginRegistry();
    const prepareDynamicModel = vi.fn(async () => undefined);
    registry.providers.push({
      pluginId: "xai",
      source: "test",
      provider: {
        id: "xai",
        label: "xAI",
        auth: [],
        prepareDynamicModel,
        normalizeTransport: () => ({ api: "openai-responses", baseUrl: model.baseUrl }),
      },
    });
    const owner = publish(() => true, config, {
      pluginRegistry: registry,
      configuredRuntimeModels: [{ provider: "xai", modelId: model.id, model }],
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "xai",
            providers: ["xai"],
            providerEndpoints: [{ endpointClass: "xai-native", hosts: ["api.x.ai"] }],
          },
        ],
      }),
    });
    const choice = { ...selection, cfg: config, raw: "xai/grok-4.6" };
    expect(await prepareModelChoice({ ...choice, source: "automatic" })).toMatchObject({
      kind: "resolved",
      model: { api: "openai-responses", baseUrl: model.baseUrl },
    });
    expect(renderPublishedAliases(owner)).toContain("- Grok: xai/grok-4.6");
    expect(prepareDynamicModel).not.toHaveBeenCalled();
    expect(await prepareModelChoice(choice)).toMatchObject({
      kind: "resolved",
      model: { api: "openai-responses", baseUrl: model.baseUrl },
    });
  });

  it("does not certify a Platform-only model on a pinned subscription route", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          openai: {
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            models: [],
          },
        },
      },
    };
    const row = {
      provider: "openai",
      id: "chat-latest",
      name: "Platform chat",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
    };
    const owner = publish(() => true, config, {
      modelCatalog: { entries: [row], routeVariants: [row] },
    });
    setPreparedModelRuntimeAuthStore(owner, {
      version: 1,
      profiles: {
        oauth: {
          provider: "openai",
          type: "oauth",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: 9_999_999_999_999,
        },
      },
    });
    expect(
      await prepareModelChoice({ ...selection, cfg: config, raw: "openai/chat-latest@oauth" }),
    ).toMatchObject({
      kind: "unavailable",
      error: expect.stringContaining("only through OpenAI Platform"),
    });
  });

  it("admits a native-owned model without requiring a host API credential", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "fixture/native",
          models: { "fixture/native": { agentRuntime: { id: "native-test" } } },
        },
      },
    };
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "native-test",
      source: "fixture",
      harness: {
        id: "native-test",
        label: "Native test",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        readModelCatalogReadiness: () => ({ accountType: "subscription", authMode: "oauth" }),
        async runAttempt() {
          throw new Error("Admission must not execute inference");
        },
      },
    });
    const row = {
      provider: "fixture",
      id: "native",
      name: "Native model",
      nativeRuntime: "native-test",
    };
    const owner = publish(() => true, config, {
      pluginRegistry: registry,
      modelCatalog: { entries: [row], routeVariants: [row] },
      configuredRuntimeModels: [
        {
          provider: "fixture",
          modelId: "native",
          model: {
            provider: "fixture",
            id: "native",
            name: "Native model",
            api: "openai-responses",
            baseUrl: "https://native.invalid/v1",
            reasoning: false,
            input: ["text"],
            contextWindow: 4096,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ],
    });
    setPreparedModelRuntimeAuthStore(owner, { version: 1, profiles: {} });
    expect(
      await prepareModelChoice({ ...selection, cfg: config, raw: "fixture/native" }),
    ).toMatchObject({ kind: "resolved", ref: { provider: "fixture", model: "native" } });
  });

  it("does not publish a choice from a replaced generation", async () => {
    publish(() => false, custom);
    expect(await prepareModelChoice({ ...selection, cfg: custom })).toMatchObject({
      kind: "unavailable",
      error: expect.stringContaining("changed during selection"),
    });
  });
});

describe("published runtime choice", () => {
  let events: Extract<DiagnosticEventPayload, { type: "model.runtime_choice" }>[];
  beforeEach(() => {
    published.owner = undefined;
    resetDiagnosticEventsForTest();
    events = [];
    onInternalDiagnosticEvent(
      (event, metadata) => {
        if (metadata.trusted && event.type === "model.runtime_choice") {
          events.push(event);
        }
      },
      { include: ["model.runtime_choice"] },
    );
  });
  afterEach(async () => {
    await waitForDiagnosticEventsDrained();
    resetDiagnosticEventsForTest();
  });

  it("keeps support admission separate from published runtime decisions", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://models.example.invalid/v1",
            models: [],
          },
        },
      },
    };
    let current = true;
    publish(() => current, config);
    expect(
      await prepareModelChoice({
        cfg: config,
        agentId: "main",
        raw: "fixture/off-catalog",
        source: "override",
      }),
    ).toMatchObject({ kind: "resolved", ref: { provider: "fixture", model: "off-catalog" } });
    await waitForDiagnosticEventsDrained();
    expect(events).toEqual([]);

    const choice = await preparePublishedModelRuntimeChoice({
      ...request,
      cfg: config,
      model: "off-catalog",
    });
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected the published runtime choice after support admission");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toContain("not available");
    await waitForDiagnosticEventsDrained();
    expect(events.map(({ phase, outcome, reason }) => ({ phase, outcome, reason }))).toEqual([
      { phase: "prepare", outcome: "ready", reason: "ready" },
      { phase: "validate", outcome: "ready", reason: "ready" },
      { phase: "validate", outcome: "unavailable", reason: "owner-stale" },
    ]);
    expect(events.at(-1)?.checks).toMatchObject({
      commitOwnerFreshness: "stale",
      nativeAvailability: "not-reached",
    });
  });

  it("refuses an unpublished or unresolved model", async () => {
    expect(await preparePublishedModelRuntimeChoice(request)).toMatchObject({
      kind: "unavailable",
    });
    publish();
    expect(
      await preparePublishedModelRuntimeChoice({ ...request, model: "unobserved" }),
    ).toMatchObject({ kind: "unavailable" });
    await waitForDiagnosticEventsDrained();
    expect(events.map((event) => event.reason)).toEqual([
      "owner-missing",
      "off-catalog-resolution-unavailable",
    ]);
    expect(events[1]?.checks).toMatchObject({
      catalogPresence: "absent",
      offCatalogAuth: "available",
      offCatalogAuthMode: "available",
      offCatalogResolution: "unresolved",
      runtimeEligibility: "not-reached",
    });
  });

  it("validates an off-catalog model through its configured route", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://models.example.invalid/v1",
            models: [],
          },
        },
      },
    };
    let current = true;
    publish(() => current, config);
    const choice = await preparePublishedModelRuntimeChoice({
      ...request,
      cfg: config,
      model: "off-catalog",
    });
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected the configured off-catalog route to be selectable");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toContain("not available");
    await waitForDiagnosticEventsDrained();
    expect(events.map((event) => event.reason)).toEqual(["ready", "ready", "owner-stale"]);
    expect(events[0]?.checks).toMatchObject({
      catalogPresence: "absent",
      offCatalogAuth: "available",
      offCatalogAuthMode: "available",
      offCatalogResolution: "resolved",
      runtimeEligibility: "eligible",
      nativeAvailability: "not-reached",
    });
    expect(events[2]?.checks.nativeAvailability).toBe("not-reached");
  });

  it("does not grant an incompatible runtime to an off-catalog model", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://models.example.invalid/v1",
            models: [],
          },
        },
      },
    };
    publish(() => true, config);
    expect(
      await preparePublishedModelRuntimeChoice({
        ...request,
        cfg: config,
        model: "off-catalog",
        runtimeId: "codex",
      }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("distinguishes absent auth ownership from an off-catalog credential refusal", async () => {
    publish(() => true, cfg, {}, false);
    expect(await preparePublishedModelRuntimeChoice(request)).toMatchObject({
      kind: "unavailable",
    });
    const owner = publish();
    setPreparedModelRuntimeAuthStore(owner, { version: 1, profiles: {} });
    expect(
      await preparePublishedModelRuntimeChoice({ ...request, model: "off-catalog" }),
    ).toMatchObject({ kind: "unavailable" });
    await waitForDiagnosticEventsDrained();
    expect(events.map((event) => event.reason)).toEqual([
      "auth-store-missing",
      "off-catalog-auth-unavailable",
    ]);
    expect(events[0]?.checks).toMatchObject({
      ownerLookup: "present",
      authStore: "absent",
      catalogPresence: "not-reached",
      runtimeEligibility: "not-reached",
    });
    expect(events[1]?.checks).toMatchObject({
      offCatalogAuth: "unavailable",
      offCatalogAuthMode: "unavailable",
      offCatalogResolution: "not-reached",
      runtimeEligibility: "not-reached",
    });
  });

  it("does not materialize off-catalog local auth without a supported auth mode", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:11434/v1",
            models: [
              {
                id: "model",
                name: "Model",
                reasoning: false,
                input: ["text"],
                contextWindow: 32000,
                maxTokens: 2048,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    const owner = publish(() => true, config);
    setPreparedModelRuntimeAuthStore(owner, { version: 1, profiles: {} });
    expect(
      await preparePublishedModelRuntimeChoice({ ...request, cfg: config, model: "off-catalog" }),
    ).toMatchObject({ kind: "unavailable" });
    await waitForDiagnosticEventsDrained();
    expect(events[0]).toMatchObject({
      reason: "off-catalog-auth-mode-unavailable",
      checks: {
        offCatalogAuth: "available",
        offCatalogAuthMode: "unavailable",
        offCatalogResolution: "not-reached",
        runtimeEligibility: "not-reached",
      },
    });
  });

  it("retains explicit account pins instead of granting a sibling profile", async () => {
    const owner = publish();
    const auth: AuthProfileStore = {
      version: 1,
      profiles: {
        "fixture:account": { type: "api_key", provider: "fixture", key: "synthetic-credential" },
        "fixture:revoked": {
          type: "token",
          provider: "fixture",
          token: "synthetic-expired-token",
          expires: 1,
        },
      },
    };
    setPreparedModelRuntimeAuthStore(owner, auth);
    const before = structuredClone(auth);
    const choice = await preparePublishedModelRuntimeChoice({
      ...request,
      sessionEntry: {
        authProfileOverride: "fixture:revoked",
        authProfileOverrideSource: "user",
        providerOverride: "fixture",
      },
    });
    expect(choice).toMatchObject({ kind: "unavailable" });
    await waitForDiagnosticEventsDrained();
    expect(events[0]?.reason).toBe("runtime-ineligible");
    expect(JSON.stringify(events)).not.toContain("fixture:revoked");
    expect(auth).toEqual(before);
  });

  it("records runtime ineligibility without adding native readiness probes", async () => {
    const owner = publish();
    expect(
      await preparePublishedModelRuntimeChoice({ ...request, runtimeId: "unregistered-runtime" }),
    ).toMatchObject({ kind: "unavailable" });
    await waitForDiagnosticEventsDrained();
    expect(events[0]).toMatchObject({
      phase: "prepare",
      reason: "runtime-ineligible",
      checks: {
        runtimeEligibility: "ineligible",
        nativeAvailability: "not-reached",
        commitOwnerFreshness: "not-reached",
      },
    });
    expect(owner.isCurrent()).toBe(true);
  });

  it("rechecks native readiness once per current guard and never after owner revocation", async () => {
    let current = true;
    let ready = true;
    const owner = publish(() => current);
    const registry = createEmptyPluginRegistry();
    const readiness = vi.fn(() =>
      ready ? { accountType: "fixture", authMode: "oauth" } : undefined,
    );
    const native = {
      provider: "fixture",
      id: "model",
      name: "Model",
      nativeRuntime: "fixture-native",
    };
    registry.agentHarnesses.push({
      pluginId: "fixture-native",
      source: "test",
      harness: {
        id: "fixture-native",
        label: "Fixture",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        readModelCatalogReadiness: readiness,
        runAttempt: async () => {
          throw new Error("unused");
        },
      },
    });
    const nativeOwner: PreparedModelRuntimeSnapshot = {
      ...owner,
      pluginRegistry: registry,
      modelCatalog: { entries: [native], routeVariants: [native] },
    };
    published.owner = nativeOwner;
    const auth: AuthProfileStore = { version: 1, profiles: {} };
    setPreparedModelRuntimeAuthStore(nativeOwner, auth);
    const choice = await preparePublishedModelRuntimeChoice({
      ...request,
      runtimeId: "fixture-native",
    });
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected native fixture readiness");
    }
    const prepareProbes = readiness.mock.calls.length;
    expect(prepareProbes).toBe(1);
    expect(choice.validate()).toBeUndefined();
    expect(readiness).toHaveBeenCalledTimes(prepareProbes + 1);
    ready = false;
    expect(choice.validate()).toContain("not available");
    expect(readiness).toHaveBeenCalledTimes(prepareProbes + 2);
    current = false;
    expect(choice.validate()).toContain("not available");
    expect(readiness).toHaveBeenCalledTimes(prepareProbes + 2);
    await waitForDiagnosticEventsDrained();
    expect(events.map((event) => event.reason)).toEqual([
      "ready",
      "ready",
      "native-unavailable",
      "owner-stale",
    ]);
    expect(events[2]?.checks).toMatchObject({
      commitOwnerFreshness: "current",
      nativeAvailability: "unavailable",
    });
    expect(events[3]?.checks).toMatchObject({
      commitOwnerFreshness: "stale",
      nativeAvailability: "not-reached",
    });
    expect(auth).toEqual({ version: 1, profiles: {} });
  });

  it("rechecks the same generation at the session commit boundary", async () => {
    let current = true;
    publish(() => current);
    const choice = await preparePublishedModelRuntimeChoice(request);
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected a supported runtime");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toContain("not available");
  });
});
