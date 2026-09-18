import { setImmediate } from "node:timers/promises";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../../packages/agent-core/src/agent.js";
import {
  acknowledgeInternalToolResult,
  attachInternalToolResultAcknowledgement,
  setInternalBeforeToolBatch,
} from "../../../packages/agent-core/src/internal-hooks.js";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type StreamFn,
  type ToolCall,
} from "../../../packages/agent-core/src/llm.js";
import { setAgentLoopRunner } from "../../../packages/agent-core/src/loop-host.js";
import type { AgentEvent, AgentTool } from "../../../packages/agent-core/src/types.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runRemoteBuiltinLoop } from "./host-loop.js";
import { EventRequestSchema } from "./loop-contract.js";
import type { Terminal } from "./protocol.js";
import { runBuiltinRuntimeLoop } from "./server-loop.js";
import { startBuiltinRuntimeServer, type RuntimeConnection } from "./server.js";
import { WireValues } from "./wire-values.js";
const token = "synthetic-runtime-test-token-0000000000";
const model: Model = {
  provider: "test",
  id: "test",
  name: "Test",
  api: "test",
  baseUrl: "",
  input: ["text"],
  reasoning: false,
  contextWindow: 8192,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const servers: Awaited<ReturnType<typeof startBuiltinRuntimeServer>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});
function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "test",
    api: "test",
    content,
    stopReason,
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function call(id: string, args: Record<string, unknown> = {}, async = true): ToolCall {
  return {
    type: "toolCall",
    name: "probe",
    id,
    arguments: args,
    ...(async ? { async: true } : {}),
  };
}
async function setup(
  streamFn: StreamFn,
  tools: AgentTool[],
  adapt?: (connection: RuntimeConnection) => RuntimeConnection,
  hasCredentialPrefix: (value: unknown) => boolean = () => false,
) {
  // A deterministic server-local stream isolates event ordering; runtime.test.ts separately proves real child-process provider I/O.
  const server = await startBuiltinRuntimeServer({
    token,
    gatewayId: "gateway",
    workspaceIds: ["workspace"],
    run: (input, connection) =>
      runBuiltinRuntimeLoop(input, adapt?.(connection) ?? connection, {
        model,
        streamFn,
        workspacePath: "/fixture-view",
        assertProtocolSafe: () => {},
        hasCredentialPrefix,
      }),
  });
  servers.push(server);
  const agent = new Agent({
    initialState: { model, tools },
    streamFn: () => {
      throw new Error("Gateway inference forbidden");
    },
  });
  const events: AgentEvent[] = [],
    terminals: Terminal[] = [];
  agent.subscribe((event) => {
    events.push(event);
    if (event.type === "message_end" && event.message.role === "toolResult") {
      acknowledgeInternalToolResult(event.message);
    }
  });
  setAgentLoopRunner(agent, (invocation) =>
    runRemoteBuiltinLoop(invocation, {
      url: "ws://127.0.0.1:" + server.port + "/runtime",
      token,
      identity: {
        gatewayId: "gateway",
        workspaceId: "workspace",
        sessionId: "session",
        runId: "run",
        attemptId: "attempt",
      },
      assertActive: () => {},
      onTerminal: (terminal) => terminals.push(terminal),
    }),
  );
  return { agent, events, terminals };
}
describe("native streamed lifecycle", () => {
  it("does not buffer later text behind a completed thinking prefix", async () => {
    const response = createAssistantMessageEventStream();
    const message = assistant([{ type: "thinking", thinking: "consider it" }]);
    response.push({ type: "start", partial: assistant([]) });
    response.push({ type: "thinking_start", contentIndex: 0, partial: message });
    response.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta: "consider it",
      partial: message,
    });
    response.push({
      type: "thinking_end",
      contentIndex: 0,
      content: "consider it",
      partial: message,
    });
    const text = assistant([...message.content, { type: "text", text: "ordinary progress" }]);
    response.push({ type: "text_start", contentIndex: 1, partial: text });
    response.push({
      type: "text_delta",
      contentIndex: 1,
      delta: "ordinary progress",
      partial: text,
    });
    const { agent, events, terminals } = await setup(
      () => response,
      [],
      undefined,
      (value) => typeof value === "string" && value.endsWith("t"),
    );
    const prompt = agent.prompt("stream");
    try {
      await vi.waitFor(() =>
        expect(
          events.some(
            (event) =>
              event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
          ),
        ).toBe(true),
      );
      expect(terminals).toHaveLength(0);
    } finally {
      response.push({
        type: "text_end",
        contentIndex: 1,
        content: "ordinary progress",
        partial: text,
      });
      response.push({ type: "done", reason: "stop", message: text });
      response.end();
      await prompt;
    }
    expect(terminals[0]?.status).toBe("completed");
  });
  it.each(["replace", "remove"] as const)(
    "honors Gateway finalization that %ss an async native call",
    async (change) => {
      const source = call("one", { text: "original" });
      const execute = vi.fn(async () => ({ content: [], details: {}, terminate: true }));
      const response = createAssistantMessageEventStream();
      response.push({ type: "start", partial: assistant([]) });
      response.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: source,
        partial: assistant([source]),
      });
      response.push({ type: "done", reason: "stop", message: assistant([source]) });
      response.end();
      const { agent, events, terminals } = await setup(
        () => response,
        [
          {
            name: "probe",
            label: "Probe",
            description: "Probe",
            parameters: Type.Object({ text: Type.String() }),
            execute,
          },
        ],
      );
      agent.subscribe(async (event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          await setImmediate();
          event.message.content = event.message.content.flatMap(
            (block): AssistantMessage["content"] =>
              block.type !== "toolCall"
                ? [block]
                : change === "remove"
                  ? []
                  : [{ ...block, arguments: { text: "corrected" } }],
          );
        }
      });
      await agent.prompt("probe");
      if (change === "remove") {
        expect(execute).not.toHaveBeenCalled();
      } else {
        expect(execute).toHaveBeenCalledExactlyOnceWith(
          "one",
          { text: "corrected" },
          expect.any(AbortSignal),
          expect.any(Function),
        );
      }
      expect(agent.state.errorMessage).toBeUndefined();
      expect(terminals[0]?.status).toBe("completed");
      expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    },
  );
  it.each(["persistence", "delivery"] as const)(
    "reconciles Gateway order when final assistant %s overlaps an async result",
    async (hold) => {
      const toolStarted = createDeferred(),
        releaseTool = createDeferred(),
        finalWaiting = createDeferred(),
        releaseFinal = createDeferred(),
        toolCommitted = createDeferred();
      const response = createAssistantMessageEventStream();
      let providerCalls = 0;
      const source = call("one");
      const acknowledged = vi.fn();
      const execute = vi.fn(async () => {
        toolStarted.resolve();
        await releaseTool.promise;
        return attachInternalToolResultAcknowledgement(
          { content: [{ type: "text" as const, text: "result" }], details: {} },
          acknowledged,
        );
      });
      const final = (event: AgentEvent) =>
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.content.some((item) => item.type === "text" && item.text === "final");
      const { agent, events, terminals } = await setup(
        () => {
          if (++providerCalls === 1) {
            return response;
          }
          const next = createAssistantMessageEventStream();
          next.push({
            type: "done",
            reason: "stop",
            message: assistant([{ type: "text", text: "after-tool" }]),
          });
          next.end();
          return next;
        },
        [
          {
            name: "probe",
            label: "Probe",
            description: "Probe",
            parameters: Type.Object({}),
            execute,
          },
        ],
        hold === "delivery"
          ? (connection) => ({
              ...connection,
              call: async (operation, input, onEvent) => {
                const request =
                  operation === "event"
                    ? EventRequestSchema.safeParse(new WireValues("runtime").decode(input))
                    : undefined;
                if (request?.success && final(request.data.event)) {
                  finalWaiting.resolve();
                  await releaseFinal.promise;
                }
                return connection.call(operation, input, onEvent);
              },
            })
          : undefined,
      );
      agent.subscribe(async (event) => {
        if (event.type === "message_end" && event.message.role === "toolResult") {
          toolCommitted.resolve();
        }
        if (hold === "persistence" && final(event)) {
          finalWaiting.resolve();
          await releaseFinal.promise;
        }
      });
      response.push({ type: "start", partial: assistant([]) });
      response.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: source,
        partial: assistant([source]),
      });
      const running = agent.prompt("overlap");
      await toolStarted.promise;
      response.push({
        type: "done",
        reason: "stop",
        message: assistant([source, { type: "text", text: "final" }]),
      });
      response.end();
      await finalWaiting.promise;
      releaseTool.resolve();
      await toolCommitted.promise;
      releaseFinal.resolve();
      await running;
      expect(agent.state.errorMessage).toBeUndefined();
      expect(acknowledged).toHaveBeenCalledTimes(1);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.status).toBe("completed");
      const terminalEvents = events.filter((event) => event.type === "agent_end");
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]?.messages).toEqual(agent.state.messages);
      expect(agent.state.messages.map((message) => message.role)).toEqual(
        hold === "delivery"
          ? ["user", "assistant", "toolResult", "assistant", "assistant"]
          : ["user", "assistant", "assistant", "toolResult", "assistant"],
      );
    },
  );
  it("preserves critical-loop terminal recovery without another model request or any tool effect", async () => {
    let modelCalls = 0;
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const { agent, events, terminals } = await setup(() => {
      const source = call("call-" + ++modelCalls, {}, false);
      const response = createAssistantMessageEventStream();
      response.push({ type: "done", reason: "toolUse", message: assistant([source], "toolUse") });
      response.end();
      return response;
    }, [
      { name: "probe", label: "Probe", description: "Probe", parameters: Type.Object({}), execute },
    ]);
    setInternalBeforeToolBatch(agent, async ({ calls }) => ({
      intervention: {
        kind: "critical-tool-loop",
        toolCallId: calls[0]!.toolCall.id,
        toolName: "probe",
        actionKey: "same",
        detector: "fixture",
        count: 2,
        reason: "loop",
      },
    }));
    await agent.prompt("loop");
    expect(modelCalls).toBe(2);
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(agent.state.messages.at(-1))).toContain(
      "tool-loop recovery encountered another critical loop",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.status).toBe("failed");
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
  });
});
