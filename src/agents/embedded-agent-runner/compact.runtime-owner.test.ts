import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  acquireAgentRunPreparedModelRuntimeMock,
  ensureAuthProfileStoreMock,
  getApiKeyForModelMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveCliBackendConfigMock,
  resolveModelAsyncMock,
  runCliAgentMock,
} from "./compact.hooks.harness.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";

const { compactEmbeddedAgentSession, compactEmbeddedAgentSessionDirect } =
  await loadCompactHooksHarness();
const [{ upsertSessionEntryCore }, { closeOpenClawAgentDatabasesForTest }, { AsyncWorkScope }] =
  await Promise.all([
    import("../../config/sessions/session-accessor.js"),
    import("../../state/openclaw-agent-db.js"),
    import("../../shared/async-work-scope.js"),
  ]);
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);
const dedicatedConfig: OpenClawConfig = {
  agents: {
    defaults: {
      embeddedAgent: {
        runtimeServer: {
          url: "ws://127.0.0.1:18791/runtime",
          gatewayId: "test-gateway",
          tokenFile: "/unused/runtime-token",
        },
      },
    },
  },
};
let params: CompactEmbeddedAgentSessionParams;

beforeEach(async () => {
  const workspaceDir = await realpath(tempDirs.make("openclaw-compaction-runtime-owner-"));
  resetCompactHooksHarnessMocks(workspaceDir);
  const sessionTarget = {
    agentId: "main",
    sessionId: "compaction-runtime-owner",
    sessionKey: "agent:main:compaction-runtime-owner",
    storePath: join(workspaceDir, "sessions.sqlite"),
  };
  await upsertSessionEntryCore(sessionTarget, { sessionId: sessionTarget.sessionId, updatedAt: 1 });
  params = {
    ...sessionTarget,
    sessionTarget,
    sessionFile: sessionTarget.sessionKey,
    workspaceDir,
    provider: "anthropic",
    model: "test-model",
    enqueue: async (task) => await task(),
  };
});

for (const [name, compact] of [
  ["queued", compactEmbeddedAgentSession],
  ["direct", compactEmbeddedAgentSessionDirect],
] as const) {
  describe(`${name} compaction runtime ownership`, () => {
    async function run(overrides: Partial<CompactEmbeddedAgentSessionParams>) {
      const work = new AsyncWorkScope();
      try {
        return await work.run(() => compact({ ...params, ...overrides }));
      } finally {
        await AsyncWorkScope.runWhenAllIdle(
          () => [work],
          () => work.drain(),
        );
      }
    }

    it.each(["manual", "overflow", "budget"] as const)(
      "rejects dedicated %s compaction before host model/auth preparation",
      async (trigger) => {
        const result = await run({ config: dedicatedConfig, agentHarnessId: "openclaw", trigger });

        expect(result).toEqual({
          ok: false,
          compacted: false,
          reason: "Compaction is not supported by the dedicated built-in runtime.",
        });
        expect(acquireAgentRunPreparedModelRuntimeMock).not.toHaveBeenCalled();
        expect(resolveModelAsyncMock).not.toHaveBeenCalled();
        expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
        expect(getApiKeyForModelMock).not.toHaveBeenCalled();
        expect(runCliAgentMock).not.toHaveBeenCalled();
      },
    );

    it("rejects implicitly selected dedicated compaction", async () => {
      expect(await run({ config: dedicatedConfig, trigger: "manual" })).toMatchObject({
        ok: false,
        compacted: false,
        reason: "Compaction is not supported by the dedicated built-in runtime.",
      });
      expect(acquireAgentRunPreparedModelRuntimeMock).not.toHaveBeenCalled();
    });

    it.each(["manual", "overflow"] as const)(
      "preserves ordinary embedded %s compaction",
      async (trigger) => {
        expect(await run({ config: {}, agentHarnessId: "openclaw", trigger })).toMatchObject({
          ok: true,
          compacted: true,
        });
        expect(acquireAgentRunPreparedModelRuntimeMock).toHaveBeenCalledOnce();
      },
    );

    it.each(["manual", "overflow"] as const)(
      "preserves explicit external %s compaction with runtime-server configured",
      async (trigger) => {
        const result = await run({
          config: dedicatedConfig,
          agentHarnessId: "external-test",
          trigger,
        });

        expect(result).toMatchObject({ ok: true, compacted: true });
        expect(acquireAgentRunPreparedModelRuntimeMock).toHaveBeenCalledOnce();
      },
    );

    it("preserves manual native CLI control before host auth preparation", async () => {
      resolveCliBackendConfigMock.mockReturnValue({
        ownsNativeCompaction: true,
        manualCompaction: { buildPrompt: () => "/compact" },
      });

      const result = await run({
        config: dedicatedConfig,
        agentHarnessId: "external-cli",
        trigger: "manual",
        cliSessionId: "native-session",
      });

      expect(result).toMatchObject({ ok: true, compacted: true });
      expect(runCliAgentMock).toHaveBeenCalledOnce();
      expect(acquireAgentRunPreparedModelRuntimeMock).not.toHaveBeenCalled();
      expect(getApiKeyForModelMock).not.toHaveBeenCalled();
    });
  });
}
