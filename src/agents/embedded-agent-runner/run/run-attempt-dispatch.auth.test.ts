import { beforeEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import type { AuthProfileStore } from "../../auth-profiles/types.js";
import { runEmbeddedAttemptWithBackend } from "./backend.js";
import { prepareAndDispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";

vi.mock("./backend.js", () => ({ runEmbeddedAttemptWithBackend: vi.fn(async () => ({})) }));
vi.mock("../../runtime-plan/build.js", () => ({
  buildAgentRuntimePlan: ({ provider, modelId }: { provider: string; modelId: string }) => ({
    resolvedRef: { provider, modelId },
    auth: {},
  }),
}));
vi.mock("../../git-coauthor-prompt.js", () => ({
  resolveSessionGitCoauthorPrompt: () => undefined,
}));
vi.mock("../../progress-card-system-prompt.js", () => ({
  appendProgressCardSystemPrompt: async () => undefined,
}));
vi.mock("../../workspace-sandbox.js", () => ({
  resolveAttemptWorkspaceSandbox: async () => undefined,
}));
vi.mock("../../session-placement-admission.js", () => ({
  resolveSessionPlacementSandbox: async () => null,
}));

const inferenceStore: AuthProfileStore = { version: 1, profiles: {} };
const fullStore: AuthProfileStore = {
  version: 1,
  profiles: { "media:default": { type: "api_key", provider: "media", key: "synthetic-tool-key" } },
};

beforeEach(() => vi.clearAllMocks());

describe("dispatch tool credential ownership", () => {
  it.each([
    { harness: "openclaw", dedicated: true, expectedToolStore: undefined },
    { harness: "openclaw", dedicated: false, expectedToolStore: fullStore },
    { harness: "copilot", dedicated: false, expectedToolStore: fullStore },
    { harness: "external-fixture", dedicated: false, expectedToolStore: undefined },
  ])(
    "dispatches $harness with dedicated=$dedicated without coupling tool and inference auth",
    async ({ harness, dedicated, expectedToolStore }) => {
      await withOpenClawTestState({ label: "dispatch-tool-auth" }, async (state) => {
        const admission = prepareSystemAgentRunAdmission({}, "dispatch-tool-auth", "main", "test");
        const admittedRunContext = await admission.admit("embedded", "test");
        try {
          const params = {
            admittedRunContext,
            config: dedicated
              ? {
                  agents: {
                    defaults: {
                      embeddedAgent: {
                        runtimeServer: {
                          url: "https://runtime.example.test",
                          gatewayId: "test",
                          tokenFile: "/fixture/token",
                        },
                      },
                    },
                  },
                }
              : {},
            runId: "dispatch-tool-auth",
            sessionId: "fixture-session",
            workspaceDir: state.workspaceDir,
            prompt: "hello",
            disableTrajectory: true,
          };
          const result = await prepareAndDispatchEmbeddedRunAttempt({
            runInput: {
              runParams: params,
              provider: "fixture",
              modelId: "fixture-model",
              workspaceResolution: { agentId: "main", workspaceDir: state.workspaceDir },
              workspaceDir: state.workspaceDir,
              agentDir: state.agentDir("main"),
              startupStages: { mark: vi.fn() },
              emitStartupStageSummary: vi.fn(),
              progressController: {
                resolveAttemptFastModeParam: () => false,
                notifyExecutionPhase: vi.fn(),
              },
              laneController: {
                createAttemptControls: () => ({
                  abortSignal: new AbortController().signal,
                  isCurrent: () => true,
                  close: vi.fn(),
                }),
              },
            },
            preparedRuntime: {
              requestedModelId: "fixture-model",
              attemptAuthProfileStore: dedicated ? inferenceStore : fullStore,
              resolveRunAttemptAuthProfileStore: () => inferenceStore,
              snapshot: () => ({
                agentHarness: { id: harness },
                pluginHarnessOwnsTransport: harness !== "openclaw",
                effectiveModel: {
                  id: "fixture-model",
                  provider: "fixture",
                  api: "openai-responses",
                  input: ["text"],
                },
                apiKeyInfo: null,
                runtimeAuthState: null,
                thinkLevel: "off",
                activePreparedAuthPlan: {
                  providerForAuth: "fixture",
                  authProfileProviderForAuth: "fixture",
                },
                providerRuntimeHandle: { provider: "fixture" },
              }),
            },
            sessionPromptState: {
              sessionId: "fixture-session",
              sessionFile: "fixture-session",
              activePrompt: { persisted: false, internal: false },
              settleOwnedTranscriptProjection: vi.fn(),
            },
            terminalRetryState: { beforeFinalizeRevisionAttempts: 0 },
            provider: "fixture",
            modelId: "fixture-model",
            startupStagesEmitted: true,
            bootstrapPromptWarningSignaturesSeen: [],
            resolveRuntimeFallbackReason: () => null,
            observeToolOutcome: vi.fn(),
            isTurnTainted: () => false,
            allocateToolOutcomeOrdinal: () => 1,
            getPostCompactionAbortError: () => undefined,
            setPostCompactionAbortController: vi.fn(),
            clearPostCompactionAbortController: vi.fn(),
          } as unknown as Parameters<typeof prepareAndDispatchEmbeddedRunAttempt>[0]);
          const dispatched = vi.mocked(runEmbeddedAttemptWithBackend).mock.lastCall?.[0];
          expect(dispatched).toBe(result.dispatchedAttempt.preparedAttempt);
          expect(dispatched?.authProfileStore).toBe(inferenceStore);
          expect(dispatched?.toolAuthProfileStore).toBe(expectedToolStore);
        } finally {
          admission.close();
        }
      });
    },
  );
});
