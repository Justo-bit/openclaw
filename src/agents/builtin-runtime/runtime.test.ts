import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { realpath, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { Agent, type AgentOptions } from "../../../packages/agent-core/src/agent.js";
import {
  attachInternalToolBatchLifecycle,
  attachInternalToolExecutionPreparer,
  attachInternalToolResultAcknowledgement,
  acknowledgeInternalToolResult,
  setInternalBeforeToolBatch,
} from "../../../packages/agent-core/src/internal-hooks.js";
import type { Model } from "../../../packages/agent-core/src/llm.js";
import { setAgentLoopRunner } from "../../../packages/agent-core/src/loop-host.js";
import type { AgentEvent, AgentTool } from "../../../packages/agent-core/src/types.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runRemoteBuiltinLoop } from "./host-loop.js";
import { decodeRuntimeFrame, type Terminal } from "./protocol.js";

const token = "synthetic-runtime-test-token-0000000000";
const modelSecret = "native-only-model-credential-fixture-472819";
const headerSecret = "test-header-credential-fixture-738291";
const bearerSecret = "native-only-bearer-credential-fixture-482731";
const model: Model = {
  id: "native-model",
  name: "Native model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://gateway-route-must-not-be-used.invalid",
  headers: { Authorization: "gateway-model-secret-must-not-cross" },
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};
const temp = useAutoCleanupTempDirTracker(afterAll);
const requests: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
const frames: string[] = [];
let streamingGate = createDeferred();
const provider = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push({ headers: request.headers, body });
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url?.endsWith("/responses")) {
      response.end(
        "data: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "native-responses",
              status: "completed",
              output: [
                {
                  type: "message",
                  id: "native-message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "native finished", annotations: [] }],
                },
              ],
              usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
            },
          }) +
          "\n\n",
      );
      return;
    }
    const serialized = JSON.stringify(body.messages);
    if (serialized.includes("hold-native-provider")) {
      return;
    }
    const toolDone = serialized.includes('"role":"tool"');
    const wantsTool = serialized.includes("use-probe") && !toolDone;
    const chunk = {
      id: "response-" + requests.length,
      object: "chat.completion.chunk",
      created: 1,
      model: body.model,
    };
    const send = (delta: unknown, finish: string | null) =>
      response.write(
        "data: " +
          JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: finish }] }) +
          "\n\n",
      );
    send({ role: "assistant" }, null);
    if (serialized.includes("stream-before-finish")) {
      send({ content: "ordinary progress" }, null);
      await streamingGate.promise;
      send({}, "stop");
    } else if (serialized.includes("split-credential")) {
      const secret = serialized.includes("bearer") ? bearerSecret : modelSecret;
      send({ content: secret.slice(0, -1) }, null);
      // Keep the partial observable before the provider finishes the credential.
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      send({ content: secret.slice(-1) }, null);
      send({}, "stop");
    } else if (serialized.includes("safe-prefix")) {
      send({ content: modelSecret.slice(0, 9) }, null);
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      send({ content: "ly ordinary text" }, null);
      send({}, "stop");
    } else if (serialized.includes("reflect-bare-bearer")) {
      send({ content: bearerSecret }, null);
      send({}, "stop");
    } else if (wantsTool) {
      send(
        {
          tool_calls: [
            {
              index: 0,
              id: "call-" + requests.length,
              type: "function",
              function: { name: "probe", arguments: "{}" },
            },
          ],
        },
        null,
      );
      send({}, "tool_calls");
    } else {
      send(
        {
          content: serialized.includes("reflect-native-credential")
            ? modelSecret
            : serialized.includes("reflect-header-credential")
              ? headerSecret
              : "native finished",
        },
        null,
      );
      send({}, "stop");
    }
    response.write(
      "data: " +
        JSON.stringify({
          ...chunk,
          choices: [],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            prompt_tokens_details: { cached_tokens: 2 },
          },
        }) +
        "\n\n",
    );
    response.end("data: [DONE]\n\n");
  })().catch((error: unknown) =>
    response.destroy(error instanceof Error ? error : new Error(String(error))),
  );
});
let entry: string;
let configPath: string;
let workspace: string;
let workspaceId: string;
let server: {
  child: ChildProcess;
  proxy: WebSocketServer;
  url: string;
  epoch: string;
  pid: number;
};
async function startServer() {
  const child = spawn(process.execPath, [entry, configPath], {
    cwd: temp.make("native-state-"),
    env: { NODE_NO_WARNINGS: "1", NATIVE_TEST_KEY: modelSecret },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (data) => {
    stderr += String(data);
  });
  const ready = await new Promise<{
    port: number;
    epoch: string;
    pid: number;
    inheritedGatewayCredential: boolean;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error("Native runtime exited " + code + ": " + stderr)),
    );
    child.once("message", (message) =>
      resolve(
        message as {
          port: number;
          epoch: string;
          pid: number;
          inheritedGatewayCredential: boolean;
        },
      ),
    );
  });
  expect(ready.inheritedGatewayCredential).toBe(false);
  const proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(proxy, "listening");
  proxy.on("connection", (client) => {
    const upstream = new WebSocket("ws://127.0.0.1:" + ready.port + "/runtime", {
      headers: { Authorization: "Bearer " + token },
    });
    const waiting: string[] = [];
    client.on("message", (data) => {
      const text = JSON.stringify(decodeRuntimeFrame(data));
      frames.push(text);
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(text);
      } else {
        waiting.push(text);
      }
    });
    upstream.on("open", () => {
      for (const text of waiting) {
        upstream.send(text);
      }
      waiting.length = 0;
    });
    upstream.on("message", (data) => {
      const text = JSON.stringify(decodeRuntimeFrame(data));
      frames.push(text);
      if (client.readyState === WebSocket.OPEN) {
        client.send(text);
      }
    });
    upstream.on("close", () => client.terminate());
    client.on("close", () => upstream.terminate());
    client.on("error", () => upstream.terminate());
    upstream.on("error", () => client.terminate());
  });
  const address = proxy.address();
  if (!address || typeof address === "string") {
    throw new Error("Proxy address unavailable");
  }
  return {
    child,
    proxy,
    url: "ws://127.0.0.1:" + address.port + "/runtime",
    epoch: ready.epoch,
    pid: ready.pid,
  };
}
async function stopServer(value: typeof server) {
  for (const client of value.proxy.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve) => {
    value.proxy.close(() => resolve());
  });
  if (value.child.exitCode !== null || value.child.signalCode !== null) {
    return;
  }
  const exited = once(value.child, "exit");
  value.child.send("close");
  await exited;
}
beforeAll(async () => {
  await new Promise<void>((resolve) => {
    provider.listen(0, "127.0.0.1", resolve);
  });
  const address = provider.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider address unavailable");
  }
  workspace = await realpath(temp.make("gateway-workspace-"));
  workspaceId = createHash("sha256").update(workspace).digest("hex");
  configPath = join(temp.make("native-startup-"), "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      models: [
        {
          provider: "openai",
          id: "native-model",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:" + address.port + "/v1",
          contextWindow: 8192,
          maxTokens: 1024,
          reasoning: true,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          apiKeyEnv: "NATIVE_TEST_KEY",
        },
        {
          provider: "openai",
          id: "native-responses",
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:" + address.port + "/v1",
          contextWindow: 8192,
          maxTokens: 321,
          cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 },
          apiKeyEnv: "NATIVE_TEST_KEY",
        },
        {
          provider: "openai",
          id: "native-mapped",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:" + address.port + "/v1",
          contextWindow: 8192,
          maxTokens: 1024,
          reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh", max: "max", low: null },
          headers: {
            "x-api-version": "1",
            "x-api-key": headerSecret,
            Authorization: "Bearer " + bearerSecret,
          },
          cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 },
          apiKeyEnv: "NATIVE_TEST_KEY",
        },
      ],
      workspaces: [
        { id: workspaceId, path: temp.make("runtime-view-a-") },
        { id: "workspace-b", path: temp.make("runtime-view-b-") },
      ],
    }),
    { mode: 0o600 },
  );
  entry = join(temp.make("native-bundle-"), "server.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./server.test-support.ts", import.meta.url))],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
  server = await startServer();
}, 30_000);
afterAll(async () => {
  if (server) {
    await stopServer(server);
  }
  provider.closeAllConnections();
  await new Promise<void>((resolve) => {
    provider.close(() => resolve());
  });
});
let serial = 0;
function remoteAgent(
  tools: AgentTool[] = [],
  options: {
    workspaceId?: string;
    beforeToolCall?: AgentOptions["beforeToolCall"];
    model?: Model;
  } = {},
) {
  const id = String(++serial),
    events: AgentEvent[] = [],
    terminals: Terminal[] = [];
  const hostInference = vi.fn(() => {
    throw new Error("Gateway inference is forbidden");
  });
  const agent = new Agent({
    initialState: { model: options.model ?? model, tools },
    streamFn: hostInference,
    beforeToolCall: options.beforeToolCall,
  });
  agent.subscribe((event) => {
    events.push(event);
    if (event.type === "message_end" && event.message.role === "toolResult") {
      acknowledgeInternalToolResult(event.message);
    }
  });
  setAgentLoopRunner(agent, (invocation) =>
    runRemoteBuiltinLoop(invocation, {
      url: server.url,
      token,
      identity: {
        gatewayId: "gateway-test",
        workspaceId: options.workspaceId ?? workspaceId,
        sessionId: "session-" + id,
        runId: "run-" + id,
        attemptId: "attempt-" + id,
      },
      assertActive: () => {},
      onTerminal: (terminal) => terminals.push(terminal),
    }),
  );
  return { agent, events, terminals, hostInference };
}
describe("dedicated native inference runtime", () => {
  it.each(["plain"])(
    "streams ordinary text before completion with t-prefixed credentials: %s",
    async (mode) => {
      streamingGate = createDeferred();
      const { agent, events, terminals } = remoteAgent([], {
        model: { ...model, id: "native-mapped" },
      });
      const prompt = agent.prompt("stream-before-finish " + mode);
      try {
        await vi.waitFor(() => {
          expect(
            events.some(
              (event) =>
                event.type === "message_update" &&
                event.assistantMessageEvent.type === "text_delta" &&
                event.assistantMessageEvent.delta === "ordinary progress",
            ),
          ).toBe(true);
        });
        expect(terminals).toHaveLength(0);
      } finally {
        streamingGate.resolve();
        await prompt;
      }
      expect(terminals[0]?.status).toBe("completed");
    },
  );
  it.each(["model", "bearer"] as const)(
    "holds reflected %s credential prefixes before publishing updates",
    async (source) => {
      const before = frames.length;
      const secret = source === "model" ? modelSecret : bearerSecret;
      const { agent, terminals } = remoteAgent([], { model: { ...model, id: "native-mapped" } });
      await agent.prompt("split-credential " + source);
      expect(terminals[0]?.status).toBe("failed");
      const wire = frames.slice(before).join("\n");
      expect(wire).not.toContain(secret);
      expect(wire).not.toContain(secret.slice(0, -1));
    },
  );
  it("rejects a bare token from a local Bearer header", async () => {
    const before = frames.length;
    const { agent, terminals } = remoteAgent([], { model: { ...model, id: "native-mapped" } });
    await agent.prompt("reflect-bare-bearer");
    expect(terminals[0]?.status).toBe("failed");
    expect(frames.slice(before).join("\n")).not.toContain(bearerSecret);
  });
  it("releases an ordinary streamed prefix once it diverges from credentials", async () => {
    const { agent, events, terminals } = remoteAgent();
    await agent.prompt("safe-prefix");
    expect(terminals[0]?.status).toBe("completed");
    const deltas = events
      .filter((event) => event.type === "message_update")
      .map((event) => event.assistantMessageEvent)
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
    expect(deltas).toBe("native-only ordinary text");
  });
  it("allows ordinary startup headers that overlap protocol metadata", async () => {
    const before = requests.length;
    const { agent, terminals } = remoteAgent([], { model: { ...model, id: "native-mapped" } });
    await agent.prompt("ordinary header metadata");
    expect(agent.state.errorMessage).toBeUndefined();
    expect(requests.slice(before)).toHaveLength(1);
    expect(requests[before]?.headers["x-api-version"]).toBe("1");
    expect(requests[before]?.headers["x-api-key"]).toBe(headerSecret);
    expect(terminals[0]?.status).toBe("completed");
  });
  it("still rejects reflected startup credential headers", async () => {
    const before = frames.length;
    const { agent, terminals } = remoteAgent([], { model: { ...model, id: "native-mapped" } });
    await agent.prompt("reflect-header-credential");
    expect(terminals[0]?.status).toBe("failed");
    expect(frames.slice(before).join("\n")).not.toContain(headerSecret);
  });
  it.each(["xhigh", "max"] as const)(
    "honors locally configured thinking %s exactly",
    async (level) => {
      const before = requests.length;
      const { agent, terminals } = remoteAgent([], { model: { ...model, id: "native-mapped" } });
      agent.state.thinkingLevel = level;
      await agent.prompt("mapped thinking selection");
      expect(agent.state.errorMessage).toBeUndefined();
      expect(requests.slice(before)).toHaveLength(1);
      expect(requests[before]?.body.reasoning_effort).toBe(level);
      expect(terminals[0]?.status).toBe("completed");
    },
  );
  it("rejects an explicit local null thinking capability before inference", async () => {
    const before = requests.length;
    const { agent, terminals } = remoteAgent([], { model: { ...model, id: "native-mapped" } });
    agent.state.thinkingLevel = "low";
    await agent.prompt("unsupported local map entry");
    expect(requests).toHaveLength(before);
    expect(terminals[0]?.status).toBe("failed");
  });
  it.each([
    {
      id: "native-mapped",
      api: "openai-completions",
      input: 8,
      output: 5,
      cacheRead: 2,
      total: 0.000038,
    },
    {
      id: "native-responses",
      api: "openai-responses",
      input: 5,
      output: 3,
      cacheRead: 0,
      total: 0.000022,
    },
  ])("accounts for runtime-local prices through $api", async (expected) => {
    const { agent, terminals } = remoteAgent([], {
      model: {
        ...model,
        id: expected.id,
        api: expected.api,
        cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
      },
    });
    await agent.prompt("local pricing accounting");
    expect(agent.state.errorMessage).toBeUndefined();
    const assistant = agent.state.messages.findLast((message) => message.role === "assistant");
    expect(assistant?.usage).toMatchObject({
      input: expected.input,
      output: expected.output,
      cacheRead: expected.cacheRead,
    });
    expect(assistant?.usage.cost.total).toBeCloseTo(expected.total, 10);
    expect(assistant?.usage.cost.input).toBeCloseTo((expected.input * 2) / 1000000, 10);
    expect(assistant?.usage.cost.output).toBeCloseTo((expected.output * 4) / 1000000, 10);
    expect(terminals[0]?.status).toBe("completed");
  });
  it.each(["xhigh", "max"] as const)(
    "rejects unsupported native thinking %s before inference",
    async (level) => {
      const before = requests.length;
      const { agent, terminals } = remoteAgent();
      agent.state.thinkingLevel = level;
      await agent.prompt("unsupported reasoning selection");
      expect(agent.state.errorMessage).toBe("Built-in runtime turn failed");
      expect(requests).toHaveLength(before);
      expect(terminals[0]?.status).toBe("failed");
    },
  );
  it.each([
    { id: "native-model", api: "openai-completions", budget: 1024 },
    { id: "native-responses", api: "openai-responses", budget: 321 },
  ])(
    "applies startup-owned output limits through the native $api loop",
    async ({ id, api, budget }) => {
      const before = requests.length;
      const { agent, hostInference, terminals } = remoteAgent([], {
        model: { ...model, id, api, maxTokens: 9999 },
      });
      await agent.prompt("native output budget");
      expect(agent.state.errorMessage).toBeUndefined();
      expect(requests.slice(before)).toHaveLength(1);
      const body = requests[before]!.body;
      expect(
        api === "openai-responses"
          ? body.max_output_tokens
          : (body.max_completion_tokens ?? body.max_tokens),
      ).toBe(budget);
      expect(hostInference).not.toHaveBeenCalled();
      expect(terminals[0]?.status).toBe("completed");
    },
  );
  it("applies the initial thinking selection to the native provider request", async () => {
    const before = requests.length;
    const { agent, hostInference, terminals } = remoteAgent();
    agent.state.thinkingLevel = "high";
    await agent.prompt("initial reasoning selection");
    expect(agent.state.errorMessage).toBeUndefined();
    expect(requests.slice(before)).toHaveLength(1);
    expect(requests[before]?.body.reasoning_effort).toBe("high");
    expect(hostInference).not.toHaveBeenCalled();
    expect(terminals[0]?.status).toBe("completed");
  });
  it("establishes provider I/O in the runtime PID with startup-only credentials and host-owned tool admission", async () => {
    const before = requests.length,
      frameStart = frames.length;
    const order: string[] = [],
      acknowledged = vi.fn();
    const execute = vi.fn(async () => {
      order.push("execute");
      return attachInternalToolResultAcknowledgement(
        {
          content: [{ type: "text" as const, text: "host result" }],
          details: { pid: process.pid },
        },
        acknowledged,
      );
    });
    const tool: AgentTool = {
      name: "probe",
      label: "Probe",
      description: "Host probe",
      parameters: Type.Object({}),
      execute,
    };
    attachInternalToolExecutionPreparer(tool, async () => ({
      kind: "ready",
      args: {},
      execute: async (start) => {
        start?.();
        return execute();
      },
      dispose: () => {},
    }));
    const { agent, events, terminals, hostInference } = remoteAgent([tool]);
    setInternalBeforeToolBatch(agent, async () =>
      attachInternalToolBatchLifecycle(
        {},
        {
          commitReadyCalls: () => {
            order.push("commit");
          },
          releaseSkippedCalls: () => {},
        },
      ),
    );
    await agent.prompt("use-probe");
    expect(
      agent.state.errorMessage,
      JSON.stringify({
        providerRequests: requests.length - before,
        frames: frames.slice(frameStart).map((raw) => {
          const frame = JSON.parse(raw) as Record<string, unknown>;
          return {
            type: frame.type,
            operation: frame.operation,
            id: frame.id,
            error: frame.error,
            code: frame.code,
          };
        }),
      }),
    ).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(acknowledged).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["commit", "execute"]);
    expect(hostInference).not.toHaveBeenCalled();
    expect(requests.slice(before)).toHaveLength(2);
    for (const request of requests.slice(before)) {
      expect(request.headers.authorization).toBe("Bearer " + modelSecret);
      expect(request.headers["x-runtime-pid"]).toBe(String(server.pid));
    }
    expect(server.pid).not.toBe(process.pid);
    const wire = frames.slice(frameStart).join("\n");
    expect(wire).not.toContain(modelSecret);
    expect(wire).not.toContain("changed-after-runtime-startup");
    expect(wire).not.toContain("gateway-model-secret");
    expect(wire).not.toContain(model.baseUrl);
    expect(wire).not.toContain('"operation":"response"');
    expect(events.some((event) => event.type === "message_update")).toBe(true);
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      status: "completed",
      binding: { epoch: server.epoch, workspaceId },
    });
  });
  it("keeps approval denial on the Gateway without executing the tool", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const approval = vi.fn(async () => ({ block: true, reason: "operator denied" }));
    const { agent, terminals } = remoteAgent(
      [
        {
          name: "probe",
          label: "Probe",
          description: "Probe",
          parameters: Type.Object({}),
          execute,
        },
      ],
      { beforeToolCall: approval },
    );
    await agent.prompt("use-probe");
    expect(approval).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(terminals[0]?.status).toBe("completed");
  });
  it("cancels pending host approval, settles host work, and produces one attributable terminal", async () => {
    const entered = createDeferred(),
      release = createDeferred();
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const { agent, events, terminals } = remoteAgent(
      [
        {
          name: "probe",
          label: "Probe",
          description: "Probe",
          parameters: Type.Object({}),
          execute,
        },
      ],
      {
        beforeToolCall: async () => {
          entered.resolve();
          await release.promise;
          return {};
        },
      },
    );
    const running = agent.prompt("use-probe");
    await entered.promise;
    agent.abort();
    release.resolve();
    await running;
    expect(execute).not.toHaveBeenCalled();
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.status).toBe("cancelled");
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
  });
  it("rejects an unallowlisted workspace before provider I/O and isolates admitted contexts", async () => {
    const before = requests.length;
    const denied = remoteAgent([], { workspaceId: "not-mapped" });
    await denied.agent.prompt("denied-workspace");
    expect(requests).toHaveLength(before);
    expect(denied.terminals[0]?.status).toBe("failed");
    const a = remoteAgent(),
      b = remoteAgent([], { workspaceId: "workspace-b" });
    await Promise.all([a.agent.prompt("view-a-only"), b.agent.prompt("view-b-only")]);
    const messages = requests.slice(before).map((request) => JSON.stringify(request.body.messages));
    expect(messages).toHaveLength(2);
    expect(
      messages.every((text) => !(text.includes("view-a-only") && text.includes("view-b-only"))),
    ).toBe(true);
  });
  it("rejects provider credential reflection before it reaches any protocol frame", async () => {
    const frameStart = frames.length;
    const { agent, terminals } = remoteAgent();
    await agent.prompt("reflect-native-credential");
    expect(terminals[0]?.status).toBe("failed");
    expect(frames.slice(frameStart).join("\n")).not.toContain(modelSecret);
  });
  it("fails disconnect without replay and uses a new epoch after restart", async () => {
    const before = requests.length;
    const { agent, events, terminals } = remoteAgent();
    const running = agent.prompt("hold-native-provider");
    await vi.waitFor(() => expect(requests.length).toBe(before + 1));
    const epoch = server.epoch;
    const exited = once(server.child, "exit");
    server.child.kill("SIGKILL");
    await exited;
    await running;
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.status).toBe("failed");
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    await stopServer(server);
    server = await startServer();
    expect(server.epoch).not.toBe(epoch);
    expect(requests.length).toBe(before + 1);
    const next = remoteAgent();
    await next.agent.prompt("fresh-native-turn");
    expect(next.terminals[0]?.status).toBe("completed");
  });
});
