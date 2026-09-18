import { describe, expect, it, vi } from "vitest";
import { setAgentLoopRunner } from "../../../packages/agent-core/src/loop-host.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";

registerAgentSessionLoopTestLifecycle();

describe("session model authentication ownership", () => {
  it("leaves prompt and direct/extension model selection authentication with the attached runtime", async () => {
    const resourceLoader = createResourceLoader();
    const { session, modelRegistry, sessionManager } = await createTestSession({ resourceLoader });
    const auth = vi.spyOn(modelRegistry, "hasConfiguredAuth").mockImplementation(() => {
      throw new Error("Gateway credentials must not be consulted");
    });
    const nativeLoop = vi.fn(async () => {});
    setAgentLoopRunner(session.agent, nativeLoop);
    await session.prompt("native prompt");
    expect(nativeLoop).toHaveBeenCalledTimes(1);
    const nextModel = { ...testModel, id: "native-next" };
    await session.setModel(nextModel);
    expect(session.model).toBe(nextModel);
    const extensionModel = { ...testModel, id: "native-extension" };
    await expect(resourceLoader.getExtensions().runtime.setModel(extensionModel)).resolves.toBe(
      true,
    );
    expect(session.model).toBe(extensionModel);
    expect(
      sessionManager
        .getEntries()
        .filter((entry) => entry.type === "model_change")
        .slice(-2)
        .map((entry) => entry.modelId),
    ).toEqual([nextModel.id, extensionModel.id]);
    expect(auth).not.toHaveBeenCalled();
    expect(streamMocks.streamSimple).not.toHaveBeenCalled();
  });

  it("retains Gateway credential preflight for ordinary embedded prompts and selections", async () => {
    const resourceLoader = createResourceLoader();
    const { session, modelRegistry } = await createTestSession({ resourceLoader });
    const auth = vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(false);
    await expect(session.prompt("embedded prompt")).rejects.toThrow("No API key");
    await expect(session.setModel({ ...testModel, id: "missing-auth" })).rejects.toThrow(
      "No API key",
    );
    await expect(
      resourceLoader.getExtensions().runtime.setModel({ ...testModel, id: "missing-auth" }),
    ).resolves.toBe(false);
    expect(auth).toHaveBeenCalledTimes(3);
    expect(streamMocks.streamSimple).not.toHaveBeenCalled();
  });
});
