import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { realpath, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  upsertSessionEntryCore,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getAgentRunContext,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import {
  decodeRuntimeFrame,
  ClientFrameSchema,
  ServerFrameSchema,
  type ClientFrame,
  type ServerFrame,
} from "../builtin-runtime/protocol.js";
import * as hostAuth from "../runtime-plan/prepare-auth.js";
import { runEmbeddedAgent } from "./run.js";
import * as hostStream from "./stream-resolution.js";

// No runner/session/tool/transcript mocks: only forbidden host auth and stream seams are trapped.
const token = "synthetic-runtime-test-token-0000000000";
const secret = "native-only-runner-fixture-key-472819";
const taskContent = "task-file-content-from-gateway-owned-read-91827";
const temp = useAutoCleanupTempDirTracker(afterAll);
const requests: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
const frames: Array<ClientFrame | ServerFrame> = [];
let state: OpenClawTestState;
let child: ChildProcess;
let proxy: WebSocketServer;
let runtimePid: number;
let runtimeEpoch: string;
let config: OpenClawConfig;
let workspace: string;
const sessionId = "native-runner-proof";
const sessionKey = "agent:main:native-runner-proof";
const runId = "native-runner-proof-run";
const target = () => ({
  agentId: "main",
  sessionId,
  sessionKey,
  storePath: state.statePath("agents", "main", "sessions", "sessions.sqlite"),
});
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  requests.push({ headers: request.headers, body });
  const toolDone = JSON.stringify(body.messages).includes('"role":"tool"');
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta: unknown, finish: string | null) =>
    response.write(
      "data: " +
        JSON.stringify({
          id: "runner-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "native-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        }) +
        "\n\n",
    );
  send({ role: "assistant" }, null);
  if (!toolDone) {
    send(
      {
        tool_calls: [
          {
            index: 0,
            id: "runner-read",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: join(workspace, "task.txt") }),
            },
          },
        ],
      },
      null,
    );
    send({}, "tool_calls");
  } else {
    send({ content: "Native runner " }, null);
    send({ content: "completed." }, null);
    send({}, "stop");
  }
  response.end("data: [DONE]\n\n");
});

beforeAll(async () => {
  state = await createOpenClawTestState({
    label: "admitted-native-runner",
    env: { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, NATIVE_TEST_KEY: undefined },
  });
  workspace = await realpath(state.workspaceDir);
  await writeFile(join(workspace, "task.txt"), taskContent);
  await new Promise<void>((resolve) => {
    provider.listen(0, "127.0.0.1", resolve);
  });
  const address = provider.address();
  if (!address || typeof address === "string") {
    throw new Error("No provider address");
  }
  const configPath = join(temp.make("runner-runtime-config-"), "config.json");
  const workspaceId = createHash("sha256").update(workspace).digest("hex");
  await writeFile(
    configPath,
    JSON.stringify({
      models: [
        {
          provider: "openai",
          id: "native-model",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:" + address.port + "/v1",
          contextWindow: 131072,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          apiKeyEnv: "NATIVE_TEST_KEY",
        },
      ],
      workspaces: [{ id: workspaceId, path: temp.make("runner-runtime-view-") }],
    }),
  );
  const entry = join(temp.make("runner-runtime-bundle-"), "server.mjs");
  await build({
    entryPoints: [
      fileURLToPath(new URL("../builtin-runtime/server.test-support.ts", import.meta.url)),
    ],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
  child = spawn(process.execPath, [entry, configPath], {
    cwd: temp.make("runner-native-state-"),
    env: { NODE_NO_WARNINGS: "1", NATIVE_TEST_KEY: secret },
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
    child.once("exit", (code) => reject(new Error("Runtime exited " + code + ": " + stderr)));
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
  runtimePid = ready.pid;
  runtimeEpoch = ready.epoch;
  proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(proxy, "listening");
  proxy.on("connection", (client) => {
    const upstream = new WebSocket("ws://127.0.0.1:" + ready.port + "/runtime", {
      headers: { Authorization: "Bearer " + token },
    });
    const waiting: string[] = [];
    client.on("message", (data) => {
      const frame = ClientFrameSchema.parse(decodeRuntimeFrame(data));
      frames.push(frame);
      const text = JSON.stringify(frame);
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
      const frame = ServerFrameSchema.parse(decodeRuntimeFrame(data));
      frames.push(frame);
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(frame));
      }
    });
    upstream.on("close", () => client.terminate());
    client.on("close", () => upstream.terminate());
    upstream.on("error", () => client.terminate());
    client.on("error", () => upstream.terminate());
  });
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") {
    throw new Error("No runtime proxy address");
  }
  const tokenFile = join(temp.make("runner-runtime-token-"), "token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  config = {
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: "openai/native-model" },
        embeddedAgent: {
          runtimeServer: {
            url: "ws://127.0.0.1:" + proxyAddress.port + "/runtime",
            tokenFile,
            gatewayId: "gateway-test",
          },
        },
      },
      entries: { main: { workspace, agentDir: state.agentDir() } },
    },
    tools: { allow: ["read"], codeMode: false, fs: { workspaceOnly: true } },
    plugins: { enabled: false },
    models: {
      providers: {
        openai: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:1/gateway-inference-forbidden",
          models: [
            {
              id: "native-model",
              name: "Synthetic native model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 131072,
              maxTokens: 1024,
            },
          ],
        },
      },
    },
    session: { store: target().storePath },
  };
  await state.writeConfig(config);
  await upsertSessionEntryCore(target(), { sessionId, updatedAt: Date.now() });
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (proxy) {
    for (const client of proxy.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => {
      proxy.close(() => resolve());
    });
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.send("close");
    await exited;
  }
  provider.closeAllConnections();
  await new Promise<void>((resolve) => {
    provider.close(() => resolve());
  });
  await state?.cleanup();
});

it("runs native inference through the admitted runner, real read tool, and canonical transcript", async () => {
  const authTrap = vi.spyOn(hostAuth, "prepareAgentRuntimeAuth").mockImplementation(() => {
    throw new Error("Gateway main-model auth forbidden");
  });
  const streamTrap = vi.spyOn(hostStream, "resolveEmbeddedAgentStream").mockImplementation(() => {
    throw new Error("Gateway main-model inference forbidden");
  });
  const events: unknown[] = [];
  const toolAuthorities: {
    authority: AgentRunDelegatedAuthority | undefined;
    active: boolean;
    pid: number;
  }[] = [];
  const partial: unknown[] = [];
  const admission = prepareSystemAgentRunAdmission(
    config,
    runId,
    "main",
    "native-runner-integration",
  );
  const result = await runEmbeddedAgent({
    preparedRunAdmission: admission,
    sessionId,
    sessionKey,
    sessionTarget: target(),
    agentId: "main",
    runId,
    workspaceDir: workspace,
    agentDir: state.agentDir(),
    config,
    provider: "openai",
    model: "native-model",
    agentHarnessId: "openclaw",
    prompt: "Read task.txt and then report completion.",
    timeoutMs: 30_000,
    onAgentEvent: (event) => {
      events.push(event);
      if (event.stream === "tool" && event.data.name === "read") {
        const authority = getAgentRunContext(runId)?.delegatedAuthority;
        toolAuthorities.push({
          authority,
          active: Boolean(authority && validateAgentRunDelegatedAuthority(authority)),
          pid: process.pid,
        });
      }
    },
    onPartialReply: (reply) => {
      partial.push(reply);
    },
  })
    .catch((error: unknown) => {
      console.info("native-runner boundary evidence", {
        providerRequests: requests.length,
        runtimeFrames: frames.length,
        nativeChildStarted: runtimePid !== process.pid,
        hostAuthCalls: authTrap.mock.calls.length,
        hostStreamCalls: streamTrap.mock.calls.length,
      });
      throw error;
    })
    .finally(() => admission.close());
  expect(result.meta.error, JSON.stringify(result)).toBeUndefined();
  expect(JSON.stringify(result.payloads)).toContain("Native runner completed.");
  expect(authTrap).not.toHaveBeenCalled();
  expect(streamTrap).not.toHaveBeenCalled();
  expect(requests).toHaveLength(2);
  expect(runtimePid).not.toBe(process.pid);
  for (const request of requests) {
    expect(request.headers.authorization).toBe("Bearer " + secret);
    expect(request.headers["x-runtime-pid"]).toBe(String(runtimePid));
  }
  expect(JSON.stringify(requests[1]?.body.messages)).toContain(taskContent);
  expect(partial.length).toBeGreaterThan(0);
  const terminal = frames.filter((frame) => frame.type === "terminal");
  expect(terminal).toHaveLength(1);
  expect(terminal[0]).toMatchObject({
    status: "completed",
    binding: { epoch: runtimeEpoch, sessionId, runId },
  });
  const transcript = loadTranscriptEventsSync(target());
  expect(JSON.stringify(transcript)).toContain(taskContent);
  expect(JSON.stringify(transcript)).toContain("Native runner completed.");
  expect(JSON.stringify(frames)).not.toContain(secret);
  expect(events.length).toBeGreaterThan(0);
  expect(toolAuthorities.length).toBeGreaterThan(0);
  for (const observed of toolAuthorities) {
    expect(observed.active).toBe(true);
    expect(observed.pid).not.toBe(runtimePid);
    expect(observed.authority).toBe(toolAuthorities[0]?.authority);
    expect(validateAgentRunDelegatedAuthority(observed.authority!)).toBe(false);
  }
}, 60_000);
