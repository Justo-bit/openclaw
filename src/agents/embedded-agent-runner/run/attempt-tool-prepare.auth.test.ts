import { beforeEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createOpenClawCodingTools } from "../../agent-tools.js";
import { upsertAuthProfile } from "../../auth-profiles.js";
import type { AuthProfileStore } from "../../auth-profiles/types.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import { hasAuthProfileForProvider } from "../../tools/model-config.helpers.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";

vi.mock("../../agent-tools.js", () => ({ createOpenClawCodingTools: vi.fn(() => []) }));
vi.mock("../../model-auth.js", () => ({ resolveModelAuthMode: vi.fn(() => "api-key") }));
vi.mock("../../computer-use-node-capabilities.js", () => ({
  loadPairedComputerUseAvailabilityForSurface: vi.fn(async () => undefined),
}));
vi.mock("../../conversation-capability-profile.js", () => ({
  resolveConversationCapabilityProfile: () => ({ policy: {} }),
}));
vi.mock("../../conversation-tool-policy-pipeline.js", () => ({
  projectConversationToolNames: () => [],
}));
vi.mock("../../tool-surface-plan.js", () => ({
  resolveAgentToolSurfacePlan: ({ config }: { config: unknown }) => ({
    codeModeControlsEnabled: false,
    toolSearchControlsEnabled: false,
    toolSearchRuntimeConfig: config,
  }),
}));

const inferenceStore: AuthProfileStore = { version: 1, profiles: {} };
const toolStore: AuthProfileStore = {
  version: 1,
  profiles: { "media:default": { type: "api_key", provider: "media", key: "synthetic-tool-key" } },
};

type PrepareInput = Parameters<typeof prepareEmbeddedAttemptToolBase>[0];
function prepare(params: {
  dedicated: boolean;
  harness?: string;
  toolStore?: AuthProfileStore;
  agentDir?: string;
}) {
  return prepareEmbeddedAttemptToolBase({
    agentDir: params.agentDir ?? "/fixture/agent",
    attempt: {
      agentId: "main",
      agentHarnessId: params.harness ?? "openclaw",
      sessionId: "fixture-session",
      sessionKey: "agent:main:fixture",
      runId: "fixture-run",
      provider: "fixture",
      modelId: "fixture-model",
      model: { provider: "fixture", id: "fixture-model", api: "openai-responses", input: ["text"] },
      admittedRunContext: {},
      config: {
        agents: {
          defaults: {
            embeddedAgent: params.dedicated
              ? {
                  runtimeServer: {
                    url: "https://runtime.example.test",
                    gatewayId: "test",
                    tokenFile: "/fixture/token",
                  },
                }
              : undefined,
          },
        },
      },
      authProfileStore: inferenceStore,
      toolAuthProfileStore: params.toolStore,
    },
    setup: createAttemptSetupFixture(),
    markCoreToolStage: vi.fn(),
    onYield: vi.fn(),
    runAbortController: new AbortController(),
    runTrace: {},
    skillUsagePaths: [],
    codeModeSkills: [],
    toolSearchCatalogExecutor: vi.fn(),
  } as unknown as PrepareInput);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveModelAuthMode).mockReset().mockReturnValue("api-key");
});

describe("attempt tool credential ownership", () => {
  it("does not classify Gateway inference auth and leaves lazy tool auth available in dedicated mode", async () => {
    vi.mocked(resolveModelAuthMode).mockImplementationOnce(() => {
      throw new Error("Gateway inference credentials must not be inspected");
    });
    const prepared = await prepare({ dedicated: true });
    expect(createOpenClawCodingTools).toHaveBeenCalledOnce();
    expect(createOpenClawCodingTools).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentDir: "/fixture/agent",
        authProfileStore: undefined,
        modelAuthMode: undefined,
      }),
    );
    prepared.refreshPermissionMode(null, vi.fn());
    expect(createOpenClawCodingTools).toHaveBeenCalledTimes(2);
    expect(resolveModelAuthMode).not.toHaveBeenCalled();
    expect(
      vi.mocked(createOpenClawCodingTools).mock.lastCall?.[0]?.authProfileStore,
    ).toBeUndefined();
  });

  it.each([
    { dedicated: false, harness: "openclaw" },
    { dedicated: true, harness: "external-fixture" },
  ])("keeps model auth classification for $harness (runtime server $dedicated)", async (params) => {
    await prepare(params);
    expect(resolveModelAuthMode).toHaveBeenCalledExactlyOnceWith(
      "fixture",
      expect.anything(),
      undefined,
      {
        workspaceDir: "/tmp/workspace",
      },
    );
    expect(vi.mocked(createOpenClawCodingTools).mock.lastCall?.[0]?.authProfileStore).toBe(
      inferenceStore,
    );
  });

  it("preserves the existing tool credential owner when the inference snapshot is empty", async () => {
    await withOpenClawTestState({ label: "dedicated-tool-credential" }, async (state) => {
      const agentDir = state.agentDir("main");
      upsertAuthProfile({
        agentDir,
        profileId: "media:default",
        credential: { type: "api_key", provider: "media", key: "synthetic-tool-key" },
      });
      await prepare({ dedicated: true, agentDir });
      const options = vi.mocked(createOpenClawCodingTools).mock.lastCall?.[0];
      // The same optional store reaches model-config.helpers from the media tools.
      // A supplied empty inference store suppresses its existing fallback.
      expect(
        hasAuthProfileForProvider({
          provider: "media",
          agentDir: options?.agentDir,
          authStore: options?.authProfileStore,
        }),
      ).toBe(true);
      expect(
        hasAuthProfileForProvider({ provider: "media", agentDir, authStore: inferenceStore }),
      ).toBe(false);
    });
  });

  it("uses the independent Gateway tool snapshot instead of a scoped inference snapshot", async () => {
    await prepare({ dedicated: false, toolStore });
    expect(vi.mocked(createOpenClawCodingTools).mock.lastCall?.[0]?.authProfileStore).toBe(
      toolStore,
    );
  });
});
