import { expect, it } from "vitest";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import {
  createMinimalRunAgentTurnParams,
  createMockReplyOperation,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const userMessage =
  "OpenCode cannot run with this chat's tool restrictions. Choose a different model provider or update the tool settings.";
const surfaces = [
  { name: "Telegram direct", provider: "telegram", chatType: "direct" },
  { name: "Discord group", provider: "discord", chatType: "group" },
  { name: "Control UI", provider: "webchat", chatType: "direct" },
  { name: "heartbeat", provider: "telegram", chatType: "direct" },
] as const;

it.each(
  surfaces.flatMap((surface) =>
    (["off", "on"] as const).map((verbose) => ({
      name: surface.name,
      provider: surface.provider,
      chatType: surface.chatType,
      verbose,
    })),
  ),
)(
  "delivers public preflight copy in $name with verbose=$verbose without diagnostic disclosure",
  async ({ name, provider, chatType, verbose }) => {
    const cause = new Error("private-cause-canary 529 overloaded");
    const error = new AgentHarnessPreflightError("private-diagnostic-canary", {
      cause,
      scope: "harness",
      userMessage,
    });
    state.runEmbeddedAgentMock.mockRejectedValueOnce(error);
    state.isInternalMessageChannelMock.mockReturnValue(name === "Control UI");
    const { replyOperation, failMock } = createMockReplyOperation();
    const params = createMinimalRunAgentTurnParams({ replyOperation });
    params.sessionCtx = {
      ...params.sessionCtx,
      Provider: provider,
      Surface: provider,
      ChatType: chatType,
    };
    params.resolvedVerboseLevel = verbose;
    params.isHeartbeat = name === "heartbeat";
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(params);

    expect(state.runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(failMock).toHaveBeenCalledWith("run_failed", error);
    expect(error.cause).toBe(cause);
    expect(result).toMatchObject({ kind: "final", payload: { text: userMessage, isError: true } });
  },
);
