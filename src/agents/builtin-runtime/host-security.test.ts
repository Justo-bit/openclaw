import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../../packages/agent-core/src/agent.js";
import type { AssistantMessage, Model } from "../../../packages/agent-core/src/llm.js";
import { setAgentLoopRunner } from "../../../packages/agent-core/src/loop-host.js";
import type { AgentEvent, AgentTool } from "../../../packages/agent-core/src/types.js";
import { runRemoteBuiltinLoop } from "./host-loop.js";
import { BatchSchema, MessageSchema, StartSchema } from "./loop-contract.js";
import type { HostOperation } from "./protocol.js";
import {
  startBuiltinRuntimeServer,
  type RuntimeConnection,
  type RuntimeServerOptions,
} from "./server.js";
import { WireValues } from "./wire-values.js";
const token = "synthetic-runtime-test-token-0000000000";
const servers: Awaited<ReturnType<typeof startBuiltinRuntimeServer>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});
const model: Model = {
  id: "test",
  name: "Test",
  provider: "test",
  api: "test",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1024,
  maxTokens: 100,
};
function assistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "one", name: "probe", arguments: {} }],
    stopReason: "toolUse",
    timestamp: 1,
    api: "test",
    provider: "test",
    model: "test",
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
async function bridge(input: unknown, connection: RuntimeConnection) {
  const values = new WireValues("runtime");
  const start = StartSchema.parse(values.decode(input));
  const call = async (operation: HostOperation, value?: unknown) =>
    values.decode(await connection.call(operation, values.encode(value), async () => {}));
  const emit = (event: AgentEvent, turn = 1, messageId?: string) =>
    call("event", { event, turn, messageId });
  await emit({ type: "agent_start" }, 0);
  await emit({ type: "turn_start" });
  for (const message of start.prompts ?? []) {
    await emit({ type: "message_start", message });
    await emit({ type: "message_end", message });
  }
  const native = async () => {
    const message = assistant();
    await emit({ type: "message_start", message }, 1, "native-one");
    const ack = MessageSchema.parse(await emit({ type: "message_end", message }, 1, "native-one"));
    values.adoptReference(message, ack);
    return message;
  };
  return { start, call, emit, native };
}
async function agentFor(run: RuntimeServerOptions["run"], tools: AgentTool[] = []) {
  const server = await startBuiltinRuntimeServer({
    token,
    gatewayId: "gateway",
    workspaceIds: ["workspace"],
    run,
  });
  servers.push(server);
  const localInference = vi.fn(() => {
    throw new Error("Gateway inference forbidden");
  });
  const agent = new Agent({ initialState: { model, tools }, streamFn: localInference });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
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
    }),
  );
  return { agent, events, localInference };
}
describe("native runtime host authority", () => {
  it("rejects a repeated native tool batch after the first effect settles", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "once" }],
      details: {},
    }));
    const { agent, localInference } = await agentFor(
      async (input, connection) => {
        const { start, call, native } = await bridge(input, connection);
        const message = await native();
        const batch = {
          context: start.context,
          message,
          calls: message.content,
          criticalToolLoopSeen: false,
          steeringMessages: [],
          hasStreamedTools: false,
        };
        BatchSchema.parse(await call("tools", { batch, turn: 1 }));
        await call("tools", { batch, turn: 1 });
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
    );
    await agent.prompt("once");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(localInference).not.toHaveBeenCalled();
    expect(agent.state.errorMessage).toBeDefined();
  });
  it.each(["native", "historical"])(
    "rejects replay of an acknowledged %s message",
    async (source) => {
      const { agent, events } = await agentFor(async (input, connection) => {
        const { start, emit, native } = await bridge(input, connection);
        const message = source === "native" ? await native() : start.context.messages[0]!;
        await emit({ type: "message_start", message }, 1, "forged-new-id");
        await emit({ type: "message_end", message }, 1, "forged-new-id");
      });
      agent.state.messages = [{ role: "user", content: "historical", timestamp: 0 }];
      await agent.prompt("current");
      expect(
        events.filter(
          (event) =>
            event.type === "message_end" &&
            event.message.role === "assistant" &&
            event.message.stopReason === "toolUse",
        ),
      ).toHaveLength(source === "native" ? 1 : 0);
      expect(agent.state.errorMessage).toBeDefined();
    },
  );
  it("rejects unpersisted native tool calls before host effects", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const { agent } = await agentFor(
      async (input, connection) => {
        const { start, call } = await bridge(input, connection);
        const message = assistant();
        await call("tools", {
          batch: {
            context: start.context,
            message,
            calls: message.content,
            criticalToolLoopSeen: false,
            steeringMessages: [],
            hasStreamedTools: false,
          },
          turn: 1,
        });
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
    );
    await agent.prompt("unpersisted");
    expect(execute).not.toHaveBeenCalled();
    expect(agent.state.errorMessage).toBeDefined();
  });
  it("rejects Gateway endpoint, headers, credentials or filesystem scope in native turn configuration", () => {
    const valid = {
      selection: { provider: "test", modelId: "test" },
      context: { systemPrompt: "", messages: [], tools: [] },
      criticalToolLoopSeen: false,
      shouldStop: false,
    };
    expect(StartSchema.safeParse(valid).success).toBe(true);
    for (const field of [
      "model",
      "config",
      "credentials",
      "workspaceDir",
      "headers",
      "endpoint",
      "cost",
      "thinkingLevelMap",
    ]) {
      expect(StartSchema.safeParse({ ...valid, [field]: "untrusted" }).success).toBe(false);
      expect(
        StartSchema.safeParse({ ...valid, selection: { ...valid.selection, [field]: "untrusted" } })
          .success,
      ).toBe(false);
    }
    expect(
      StartSchema.safeParse({ ...valid, context: { ...valid.context, cwd: "/untrusted" } }).success,
    ).toBe(false);
  });
  it("rejects fabricated host tool results and duplicate terminal events", async () => {
    const { agent, events } = await agentFor(async (input, connection) => {
      const { emit } = await bridge(input, connection);
      await emit({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "forged",
          toolName: "probe",
          content: [],
          isError: false,
          timestamp: 1,
        },
      });
    });
    await agent.prompt("no result");
    expect(
      events.some((event) => event.type === "message_end" && event.message.role === "toolResult"),
    ).toBe(false);
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
  });
});
