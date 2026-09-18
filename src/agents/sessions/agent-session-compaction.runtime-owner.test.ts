import { describe, expect, it, vi } from "vitest";
import { setAgentLoopRunner } from "../../../packages/agent-core/src/loop-host.js";
import {
  appendHistory,
  createAssistant,
  createAssistantResultStream,
  createAutoCompactionSettings,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

describe("AgentSession compaction runtime ownership", () => {
  it.each(["registry", "custom"] as const)(
    "rejects dedicated compaction before auth with a %s stream",
    async (streamKind) => {
      const sessionManager = SessionManager.inMemory();
      appendHistory(
        sessionManager,
        createAssistant(testModel, [{ type: "text", text: "old answer" }]),
      );
      const { session, modelRegistry } = await createTestSession({
        sessionManager,
        settingsManager: createAutoCompactionSettings(),
      });
      const auth = vi.spyOn(modelRegistry, "getApiKeyAndHeaders");
      const customStream = vi.fn(() => {
        throw new Error("Host provider streaming must not run");
      });
      if (streamKind === "custom") {
        session.agent.streamFn = customStream;
      }
      const nativeLoop = vi.fn(async () => {});
      setAgentLoopRunner(session.agent, nativeLoop);
      const entriesBefore = sessionManager.getEntries();

      await expect(session.compact()).rejects.toThrow(
        "Host model operations are not supported by the dedicated built-in runtime",
      );

      expect(auth).not.toHaveBeenCalled();
      expect(customStream).not.toHaveBeenCalled();
      expect(streamMocks.streamSimple).not.toHaveBeenCalled();
      expect(nativeLoop).not.toHaveBeenCalled();
      expect(sessionManager.getEntries()).toEqual(entriesBefore);
      expect(session.isCompacting).toBe(false);
    },
  );

  it("keeps ordinary embedded compaction on its registry and stream", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(
      sessionManager,
      createAssistant(testModel, [{ type: "text", text: "old answer" }]),
    );
    const { session, modelRegistry } = await createTestSession({
      sessionManager,
      settingsManager: createAutoCompactionSettings(),
    });
    const auth = vi.spyOn(modelRegistry, "getApiKeyAndHeaders");
    streamMocks.streamSimple.mockImplementation(() =>
      createAssistantResultStream(
        createAssistant(testModel, [{ type: "text", text: "Summary of prior conversation." }]),
      ),
    );

    await session.compact();

    expect(auth).toHaveBeenCalled();
    expect(streamMocks.streamSimple).toHaveBeenCalled();
    expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
  });

  it("rejects dedicated branch summarization before auth", async () => {
    const sessionManager = SessionManager.inMemory();
    const root = sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
    const abandoned = sessionManager.appendMessage({
      role: "user",
      content: "old branch",
      timestamp: 2,
    });
    sessionManager.branch(root);
    const target = sessionManager.appendMessage(
      createAssistant(testModel, [{ type: "text", text: "target branch" }]),
    );
    sessionManager.branch(abandoned);
    const { session, modelRegistry } = await createTestSession({ sessionManager });
    const auth = vi.spyOn(modelRegistry, "getApiKeyAndHeaders");
    setAgentLoopRunner(
      session.agent,
      vi.fn(async () => {}),
    );

    const leafBefore = sessionManager.getLeafId();
    await expect(session.navigateTree(target, { summarize: true })).rejects.toThrow(
      "Host model operations are not supported by the dedicated built-in runtime",
    );

    expect(auth).not.toHaveBeenCalled();
    expect(streamMocks.streamSimple).not.toHaveBeenCalled();
    expect(sessionManager.getLeafId()).toBe(leafBefore);
  });
});
