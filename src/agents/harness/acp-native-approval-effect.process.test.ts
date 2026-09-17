import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-identity-token.js";
import { createTestApprovalManager } from "../../gateway/exec-approval-manager.test-support.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../gateway/methods/registry.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { cancelAgentRuntimeBoundApprovals } from "../../gateway/server-methods/approval-run-cancellation.js";
import { createPluginApprovalHandlers } from "../../gateway/server-methods/plugin-approval.js";
import {
  registerAgentRunDelegatedAuthorityClosedHandler,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { createTestPluginApi } from "../../plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/plugin-test-runtime.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { createPluginStateKeyedStore } from "../../plugin-state/plugin-state-store.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import type { OpenClawPluginDefinition, OpenClawPluginService } from "../../plugins/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore as createDeferred } from "../../shared/deferred.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { createEmptyAgentDiscoveryStores } from "../embedded-agent-runner/model.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { registerAgentHarness } from "./registry.js";
import { runAgentHarnessAttempt } from "./selection.js";

const peer = fileURLToPath(
  new URL("../../../extensions/acpx/test/fixtures/approval-effect-agent.mjs", import.meta.url),
);
type ServiceModule = {
  createAcpxRuntimeService: () => OpenClawPluginService;
};
let snapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
beforeEach(() => {
  snapshot = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(createEmptyPluginRegistry());
});
afterEach(() => {
  restoreActivePluginRegistrySnapshot(snapshot);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function registerNative(state: OpenClawTestState, config: OpenClawConfig) {
  const peerDirectory = state.path("peer");
  await fs.mkdir(peerDirectory);
  await fs.mkdir(path.join(peerDirectory, "effects"));
  const module = await loadBundledPluginFacade<ServiceModule>({
    pluginId: "acpx",
    artifactBasename: "register.runtime.js",
  });
  const factory = vi.spyOn(module, "createAcpxRuntimeService");
  const { default: plugin } = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
    pluginId: "acpx",
    artifactBasename: "index.js",
  });
  const api = createTestPluginApi({
    id: "acpx",
    config,
    pluginConfig: {
      cwd: state.workspaceDir,
      stateDir: state.path("acpx-runtime"),
      agents: { opencode: { command: process.execPath, args: [peer, peerDirectory] } },
    },
    runtime: createPluginRuntimeMock({
      state: {
        resolveStateDir: () => state.stateDir,
        openKeyedStore: (options) => createPluginStateKeyedStore("acpx", options),
      },
    }),
    registerAgentHarness: (harness) => registerAgentHarness(harness, { ownerPluginId: "acpx" }),
  });
  if (!plugin.register) {
    throw new Error("ACPX registration missing");
  }
  plugin.register(api);
  const result = factory.mock.results.at(-1);
  if (!result || result.type !== "return") {
    throw new Error("ACPX service missing");
  }
  const service = result.value;
  const context = {
    config,
    workspaceDir: state.workspaceDir,
    stateDir: state.stateDir,
    logger: api.logger,
  };
  return { peerDirectory, service, context };
}

async function attemptFor(state: OpenClawTestState, config: OpenClawConfig) {
  const target = {
    agentId: "main",
    sessionKey: "agent:main:chat",
    sessionId: "native-approval-effect",
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  const entry = { sessionId: target.sessionId, updatedAt: Date.now() };
  await upsertSessionEntry({ ...target, entry });
  const runId = "native-approval-effect";
  const admission = prepareAgentRunAdmission({
    cfg: config,
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "native-approval-effect-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  const admittedRunContext = await admission.admit("plugin-harness", "acpx");
  const provider = "acp-opencode";
  const input: EmbeddedRunAttemptParams = {
    ...target,
    ...createEmptyAgentDiscoveryStores(),
    admittedRunContext,
    config,
    runId,
    workspaceDir: state.workspaceDir,
    sessionFile: "sqlite://native-approval-effect",
    provider,
    modelId: "selected",
    agentHarnessRuntimeOverride: provider,
    permissionMode: "full",
    prompt: "Record the requested native effect.",
    timeoutMs: 30000,
    thinkLevel: "off",
    model: {
      id: "selected",
      name: "Selected",
      api: "openai-completions",
      provider,
      baseUrl: "",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 2048,
    },
    authProfileStore: { version: 1, profiles: {} },
    userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
      message: {
        role: "user",
        content: "Record the requested native effect.",
        timestamp: Date.now(),
      },
      target: { ...target, sessionEntry: entry },
      updateMode: "none",
    }),
  };
  return { input, close: admission.close };
}

it.for(["revoke", "cancel", "timeout", "active"] as const)(
  "fences real native effects while the Gateway approval waits: %s",
  { timeout: 60000 },
  async (kind, test) => {
    await withOpenClawTestState({ label: "acp-native-approval-effect" }, async (state) => {
      const config: OpenClawConfig = {
        session: { store: path.join(state.sessionsDir(), "sessions.json") },
      };
      const manager = createTestApprovalManager<PluginApprovalRequestPayload>(test, {
        approvalKind: "plugin",
        validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
      });
      const gatewayWork = new AsyncWorkScope();
      const handlers = createPluginApprovalHandlers(manager);
      const methods = createGatewayMethodRegistry(createCoreGatewayMethodDescriptors(handlers));
      const context = createDirectChatContext({
        getRuntimeConfig: () => config,
        getGatewayMethodRegistry: () => methods,
        trackExecution: (run) => gatewayWork.track(run),
        pluginApprovalManager: manager,
        hasExecApprovalClients: () => true,
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      });
      const stopWatchingAuthority = registerAgentRunDelegatedAuthorityClosedHandler(
        (authority, reason) => {
          cancelAgentRuntimeBoundApprovals({
            authority,
            reason,
            manager,
            publish: () => {},
          });
        },
      );
      let native: Awaited<ReturnType<typeof registerNative>> | undefined;
      try {
        native = await registerNative(state, config);
        const attempt = await attemptFor(state, config);
        bindGatewayContextResolver(attempt.input.admittedRunContext, () => context);
        const entered = createDeferred<string>();
        const awaitDecision = manager.awaitDecision.bind(manager);
        vi.spyOn(manager, "awaitDecision").mockImplementation((id) => {
          const decision = awaitDecision(id);
          entered.resolve(id);
          return decision;
        });
        const abort = new AbortController();
        attempt.input.abortSignal = abort.signal;
        if (kind === "timeout") {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        }
        const run = runAgentHarnessAttempt(attempt.input);
        void run.catch(() => {});
        try {
          const approvalId = await Promise.race([
            entered.promise,
            run.then((result) => {
              throw new Error(
                `Attempt ended before approval wait: ${JSON.stringify(result.terminal)}`,
              );
            }),
          ]);
          expect(manager.listPendingRecords()).toHaveLength(1);
          expect(manager.getSnapshot(approvalId)).toMatchObject({
            request: {
              pluginId: "acpx",
              runId: attempt.input.runId,
              sessionKey: attempt.input.sessionKey,
              toolCallId: "native-write",
              allowedDecisions: ["allow-once", "deny"],
            },
          });
          expect(
            JSON.parse(await fs.readFile(state.path("peer", "permission-request.json"), "utf8")),
          ).toMatchObject({ toolCallId: "native-write", kind: "edit" });
          expect(await fs.readdir(state.path("peer", "effects"))).toEqual([]);
          if (kind === "revoke") {
            attempt.close();
          } else if (kind === "cancel") {
            abort.abort();
          } else if (kind === "timeout") {
            await vi.advanceTimersByTimeAsync(attempt.input.timeoutMs);
            vi.useRealTimers();
          }
          // Submit the same allow after each closure; only a live owner may receive it.
          const resolution = manager.resolveDetailed(approvalId, "allow-once", {
            kind: "device",
            id: "test-reviewer",
          });
          expect(resolution.outcome).toBe(kind === "active" ? "resolved" : "already-resolved");
          const result = await run;
          expect(result.terminal).toMatchObject({
            kind:
              kind === "active"
                ? "ok"
                : kind === "timeout"
                  ? "timeout"
                  : kind === "cancel"
                    ? "aborted"
                    : "failed",
          });
          expect(manager.listPendingRecords()).toEqual([]);
          if (kind !== "active") {
            expect(manager.getSnapshot(approvalId)).toMatchObject({
              status: "cancelled",
              terminalReason: "run-aborted",
            });
          }
        } finally {
          abort.abort();
          attempt.close();
          vi.useRealTimers();
          await Promise.allSettled([run]);
        }
      } finally {
        stopWatchingAuthority();
        if (native) {
          await native.service.stop?.(native.context);
        }
        await manager.drain();
        await gatewayWork.drain();
      }
      // Inspect after shutdown so a late native permission reply cannot race this assertion.
      expect(await fs.readdir(state.path("peer", "effects"))).toEqual(
        kind === "active" ? ["native-effect.txt"] : [],
      );
      if (kind === "active") {
        expect(await fs.readFile(state.path("peer", "effects", "native-effect.txt"), "utf8")).toBe(
          "approved native effect",
        );
        expect(
          JSON.parse(await fs.readFile(state.path("peer", "permission-result.json"), "utf8")),
        ).toMatchObject({ outcome: { outcome: "selected", optionId: "allow" } });
      }
    });
  },
);
