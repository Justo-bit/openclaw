import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  buildExternalRunFailureReply,
  buildKnownAgentRunFailureReplyPayload,
} from "../../auto-reply/reply/agent-runner-failure-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
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
import type { OpenClawPluginDefinition } from "../../plugins/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
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

const agents = ["opencode", "qwen", "pi", "kilocode"] as const;
const peer = fileURLToPath(
  new URL("../../../extensions/acpx/test/fixtures/owner-agent.mjs", import.meta.url),
);
type ServiceModule = typeof import("../../../extensions/acpx/register.runtime.js");
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
      agents: Object.fromEntries(
        agents.map((agent) => [
          agent,
          { command: process.execPath, args: [peer, peerDirectory, "--model-controls"] },
        ]),
      ),
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

async function attemptFor(
  state: OpenClawTestState,
  config: OpenClawConfig,
  agent: string,
  permissionMode?: "full",
) {
  const target = {
    agentId: "main",
    sessionKey: "agent:main:chat",
    sessionId: "native-execution",
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  const entry = { sessionId: target.sessionId, updatedAt: Date.now() };
  await upsertSessionEntry({ ...target, entry });
  const runId = "native-execution";
  const admission = prepareAgentRunAdmission({
    cfg: config,
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "native-execution-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  const admittedRunContext = await admission.admit("plugin-harness", "acpx");
  const provider = `acp-${agent}`;
  const input: EmbeddedRunAttemptParams = {
    ...target,
    ...createEmptyAgentDiscoveryStores(),
    admittedRunContext,
    config,
    runId,
    workspaceDir: state.workspaceDir,
    sessionFile: "sqlite://native-execution",
    provider,
    modelId: "selected",
    agentHarnessRuntimeOverride: provider,
    permissionMode,
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

type PeerState = { history: string[]; currentModelId: string; modelChanges: string[] };
async function peerStates(directory: string): Promise<PeerState[]> {
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
  return Promise.all(
    names.map(async (name) => JSON.parse(await fs.readFile(path.join(directory, name), "utf8"))),
  );
}

const policyCases = agents.flatMap((agent) =>
  [
    (["messaging", "minimal", "full", undefined] as const).flatMap((profile) =>
      (["full", undefined] as const).map((permissionMode) => ({
        agent,
        profile,
        permissionMode,
        alsoAllow: undefined,
        denied: profile === "minimal" || profile === "messaging",
      })),
    ),
    [
      {
        agent,
        profile: "coding" as const,
        permissionMode: "full" as const,
        alsoAllow: undefined,
        denied: agent === "kilocode",
      },
    ],
    agent === "kilocode"
      ? [
          {
            agent,
            profile: "coding" as const,
            permissionMode: "full" as const,
            alsoAllow: ["message"],
            denied: false,
          },
        ]
      : [],
  ].flat(),
);
it.each(policyCases)(
  "admits $agent profile=$profile permission=$permissionMode alsoAllow=$alsoAllow before native effects",
  async ({ agent, profile, permissionMode, alsoAllow, denied }) => {
    await withOpenClawTestState({ label: "acp-native-policy" }, async (state) => {
      const config: OpenClawConfig = {
        session: { store: path.join(state.sessionsDir(), "sessions.json") },
        tools: { profile, alsoAllow },
      };
      const native = await registerNative(state, config);
      const attempt = await attemptFor(state, config, agent, permissionMode);
      try {
        const outcome = await runAgentHarnessAttempt(attempt.input).then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        const records = await peerStates(native.peerDirectory);
        const effects = await fs.readdir(path.join(native.peerDirectory, "effects"));
        if (denied) {
          expect.soft(outcome.error).toMatchObject({
            message: expect.stringContaining("cannot enforce this conversation's tool policy"),
          });
          expect.soft(records).toEqual([]);
          expect.soft(effects).toEqual([]);
          const reply = buildExternalRunFailureReply({
            message: formatErrorMessage(outcome.error),
            error: outcome.error,
          });
          expect.soft(reply.text).toContain("cannot run with this chat's tool restrictions");
          expect.soft(reply.text).toContain("Choose a different model provider");
          expect.soft(reply.text).not.toContain("try again");
          expect.soft(reply.text).not.toContain("/new");
          expect.soft(reply.isGenericRunnerFailure).toBe(false);
          expect
            .soft(
              buildKnownAgentRunFailureReplyPayload({
                err: outcome.error,
                sessionCtx: { Provider: "discord", Surface: "discord", ChatType: "group" },
                resolvedVerboseLevel: "off",
              }),
            )
            .toMatchObject({ text: reply.text, isError: true });
        } else {
          expect.soft(outcome.error).toBeUndefined();
          expect.soft(outcome.value?.terminal).toMatchObject({ kind: "ok" });
          expect.soft(records).toHaveLength(1);
          expect.soft(records[0]?.history).toHaveLength(1);
          expect.soft(effects).toHaveLength(1);
        }
      } finally {
        attempt.close();
        await native.service.stop?.(native.context);
      }
    });
  },
  60000,
);

it.each(["cancel", "timeout", "revoke", "active"] as const)(
  "checks authority after delayed real status: %s",
  async (kind) => {
    await withOpenClawTestState({ label: "acp-native-model-authority" }, async (state) => {
      const config: OpenClawConfig = {
        session: { store: path.join(state.sessionsDir(), "sessions.json") },
      };
      const native = await registerNative(state, config);
      const attempt = await attemptFor(state, config, "opencode", "full");
      try {
        const runtime = await native.service.getRuntime(native.context);
        const handle = await runtime.ensureSession({
          agentId: "main",
          sessionKey: `agent:main:harness:acp-opencode:${attempt.input.sessionId}`,
          agent: "opencode",
          cwd: state.workspaceDir,
          mode: "persistent",
          model: "initial",
          modelExplicit: true,
        });
        const before = await peerStates(native.peerDirectory);
        const entered = createDeferred();
        const release = createDeferred();
        const getStatus = runtime.getStatus.bind(runtime);
        vi.spyOn(runtime, "getStatus").mockImplementationOnce(async (input) => {
          const status = await getStatus(input);
          entered.resolve();
          await release.promise;
          return status;
        });
        const controls = vi.spyOn(runtime, "setModel");
        const abort = new AbortController();
        attempt.input.abortSignal = abort.signal;
        if (kind === "timeout") {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        }
        const run = runAgentHarnessAttempt(attempt.input);
        void run.catch(() => {});
        try {
          await Promise.race([
            entered.promise,
            run.then(() => {
              throw new Error("Attempt ended before status gate");
            }),
          ]);
          if (kind === "cancel") {
            abort.abort();
          }
          if (kind === "revoke") {
            attempt.close();
          }
          if (kind === "timeout") {
            await vi.advanceTimersByTimeAsync(attempt.input.timeoutMs);
            vi.useRealTimers();
          }
          release.resolve();
          const outcome = await run.then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error }),
          );
          const records = await peerStates(native.peerDirectory);
          const effects = await fs.readdir(path.join(native.peerDirectory, "effects"));
          const persisted = await getStatus({ handle });
          if (kind === "active") {
            expect.soft(outcome.error).toBeUndefined();
            expect.soft(outcome.value?.terminal).toMatchObject({ kind: "ok" });
            expect.soft(controls).toHaveBeenCalledOnce();
            expect.soft(persisted.models?.currentModelId).toBe("selected");
            expect.soft(records[0]?.history).toHaveLength(1);
            expect.soft(effects).toHaveLength(1);
          } else {
            expect.soft(outcome.error).toBeUndefined();
            expect.soft(outcome.value?.terminal).toMatchObject({
              kind: kind === "timeout" ? "timeout" : kind === "cancel" ? "aborted" : "failed",
            });
            expect.soft(controls).not.toHaveBeenCalled();
            expect.soft(persisted.models?.currentModelId).toBe("initial");
            expect.soft(records).toEqual(before);
            expect.soft(effects).toEqual([]);
          }
        } finally {
          release.resolve();
          vi.useRealTimers();
          await Promise.allSettled([run]);
        }
      } finally {
        attempt.close();
        await native.service.stop?.(native.context);
      }
    });
  },
  60000,
);
