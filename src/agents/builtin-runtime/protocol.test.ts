import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { runBuiltinRuntimeClient } from "./client.js";
import {
  assertRuntimeUrl,
  decodeRuntimeFrame,
  ServerFrameSchema,
  type ServerFrame,
  type TurnBinding,
} from "./protocol.js";
import { startBuiltinRuntimeServer, type RuntimeServerOptions } from "./server.js";
import { WireValues } from "./wire-values.js";
const token = "synthetic-runtime-test-token-0000000000";
const identity = {
  gatewayId: "gateway",
  workspaceId: "workspace",
  sessionId: "session",
  runId: "run",
  attemptId: "attempt",
};
const servers: Awaited<ReturnType<typeof startBuiltinRuntimeServer>>[] = [];
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.terminate();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});
async function listen(run: RuntimeServerOptions["run"] = async () => {}) {
  const server = await startBuiltinRuntimeServer({
    token,
    gatewayId: "gateway",
    workspaceIds: ["workspace"],
    run,
  });
  servers.push(server);
  return "ws://127.0.0.1:" + server.port + "/runtime";
}
async function connect(url: string) {
  const ws = new WebSocket(url, { headers: { Authorization: "Bearer " + token } });
  clients.push(ws);
  const queue: ServerFrame[] = [];
  const waits: ((frame: ServerFrame) => void)[] = [];
  ws.on("message", (data) => {
    const frame = ServerFrameSchema.parse(decodeRuntimeFrame(data));
    const wait = waits.shift();
    if (wait) {
      wait(frame);
    } else {
      queue.push(frame);
    }
  });
  ws.on("error", () => {});
  await once(ws, "open");
  return {
    ws,
    send: (value: unknown) => ws.send(JSON.stringify(value)),
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift()!)
        : new Promise<ServerFrame>((resolve) => {
            waits.push(resolve);
          }),
  };
}
async function initialize(client: Awaited<ReturnType<typeof connect>>) {
  client.send({ type: "initialize", gatewayId: "gateway", minVersion: 1, maxVersion: 1 });
  const ready = await client.next();
  if (ready.type !== "ready") {
    throw new Error("Expected ready");
  }
  return {
    ...identity,
    epoch: ready.epoch,
    connectionId: ready.connectionId,
  } satisfies TurnBinding;
}
describe("runtime protocol security and lifecycle", () => {
  it.each([undefined, "wrong", token + "wrong"])(
    "rejects absent or wrong bearer authentication (%s)",
    async (value) => {
      const url = await listen();
      const ws = new WebSocket(url, { headers: value ? { Authorization: "Bearer " + value } : {} });
      clients.push(ws);
      ws.on("error", () => {});
      const status = await new Promise<number>((resolve) => {
        ws.once("unexpected-response", (_req, res) => {
          resolve(res.statusCode!);
          res.destroy();
        });
      });
      expect(status).toBe(401);
    },
  );
  it("rejects browser-origin upgrades even with a token", async () => {
    const url = await listen();
    const ws = new WebSocket(url, {
      headers: { Authorization: "Bearer " + token, Origin: "https://example.test" },
    });
    clients.push(ws);
    ws.on("error", () => {});
    const status = await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode!);
        res.destroy();
      });
    });
    expect(status).toBe(401);
  });
  it.each([
    [2, 3],
    [0, 0],
    [2, 1],
  ])("rejects incompatible negotiation %s..%s before dispatch", async (minVersion, maxVersion) => {
    const run = vi.fn(async () => {});
    const client = await connect(await listen(run));
    client.send({ type: "initialize", gatewayId: "gateway", minVersion, maxVersion });
    expect(await client.next()).toMatchObject({ type: "error", code: "version" });
    expect(run).not.toHaveBeenCalled();
  });
  it("requires initialization and exact gateway identity", async () => {
    const url = await listen();
    const before = await connect(url);
    before.send({ type: "cancel", binding: { ...identity, epoch: "old", connectionId: "old" } });
    expect(await before.next()).toMatchObject({ type: "error", code: "protocol" });
    const wrong = await connect(url);
    wrong.send({ type: "initialize", gatewayId: "other", minVersion: 1, maxVersion: 1 });
    expect(await wrong.next()).toMatchObject({ type: "error", code: "scope" });
  });
  it.each(["epoch", "connectionId", "workspaceId"])(
    "rejects a stale or ungranted %s",
    async (field) => {
      const run = vi.fn(async () => {});
      const client = await connect(await listen(run));
      const binding = await initialize(client);
      client.send({ type: "start", binding: { ...binding, [field]: "wrong" }, input: {} });
      expect(await client.next()).toMatchObject({ type: "error", code: "scope" });
      expect(run).not.toHaveBeenCalled();
    },
  );
  it("rejects duplicate tool results rather than applying them to a later request", async () => {
    const client = await connect(
      await listen(async (_input, host) => {
        await host.call("tools", {});
        await host.call("modelContext", {});
      }),
    );
    const binding = await initialize(client);
    client.send({ type: "start", binding, input: {} });
    const first = await client.next();
    expect(first.type).toBe("call");
    if (first.type !== "call") {
      throw new Error("missing call");
    }
    client.send({ type: "result", binding, id: first.id, value: {} });
    expect(await client.next()).toMatchObject({ type: "call", id: first.id + 1 });
    client.send({ type: "result", binding, id: first.id, value: {} });
    expect(await client.next()).toMatchObject({ type: "error", code: "protocol" });
    expect(await client.next()).toMatchObject({ type: "terminal", status: "failed", binding });
  });
  it("rejects a tool result from another attempt and preserves result attribution", async () => {
    const client = await connect(
      await listen(async (_input, host) => {
        await host.call("tools", {});
      }),
    );
    const binding = await initialize(client);
    client.send({ type: "start", binding, input: {} });
    const call = await client.next();
    if (call.type !== "call") {
      throw new Error("missing call");
    }
    client.send({
      type: "result",
      binding: { ...binding, attemptId: "other-attempt" },
      id: call.id,
      value: {},
    });
    expect(await client.next()).toMatchObject({ type: "error", code: "scope" });
    expect(await client.next()).toMatchObject({ type: "terminal", status: "failed", binding });
  });
  it("rejects a replacement owner while the original connection owns the session", async () => {
    const url = await listen(async (_input, host) => {
      await host.call("tools", {});
    });
    const first = await connect(url);
    const a = await initialize(first);
    first.send({ type: "start", binding: a, input: {} });
    await first.next();
    const second = await connect(url);
    const b = await initialize(second);
    second.send({ type: "start", binding: { ...b, attemptId: "replacement" }, input: {} });
    expect(await second.next()).toMatchObject({ type: "error", code: "busy" });
    first.send({ type: "cancel", binding: a });
    expect(await first.next()).toMatchObject({ type: "terminal", status: "cancelled", binding: a });
  });
  it("does not leak the local session fence after synchronous WebSocket construction failure", async () => {
    const url = await listen();
    const args = {
      url,
      token,
      identity,
      signal: new AbortController().signal,
      assertActive: () => {},
      input: {},
      host: async () => ({}),
    };
    await expect(runBuiltinRuntimeClient({ ...args, token: token + "\n" })).rejects.toThrow();
    await expect(runBuiltinRuntimeClient(args)).resolves.toMatchObject({ status: "completed" });
  });
  it("rejects unsafe endpoint forms and permits TLS or loopback", () => {
    for (const url of [
      "ws://example.test/runtime",
      "wss://user:password@example.test/runtime",
      "wss://example.test/runtime?token=x",
      "http://127.0.0.1/runtime",
    ]) {
      expect(() => assertRuntimeUrl(url)).toThrow();
    }
    expect(assertRuntimeUrl("wss://example.test/runtime").protocol).toBe("wss:");
    expect(assertRuntimeUrl("ws://127.0.0.1/runtime").protocol).toBe("ws:");
  });
});
describe("per-turn host reference codec", () => {
  it("does not retain streaming observations as host transcript references", () => {
    const host = new WireValues("host");
    const runtime = new WireValues("runtime");
    const partial = { role: "assistant", content: "partial", timestamp: 1 };
    expect(runtime.decode(host.encode(partial, false))).toEqual(partial);
    expect(host.owns(partial)).toBe(false);
  });
  it("preserves runtime identity across repeated projections and host WeakMap identity on return", () => {
    const host = new WireValues("host");
    const runtime = new WireValues("runtime");
    const message = { role: "user", content: "one steer", timestamp: 1 };
    const original = new WeakMap<object, string>([[message, "owned"]]);
    const decoded = runtime.decode(host.encode([message, message])) as object[];
    expect(decoded[0]).toBe(decoded[1]);
    expect(new Set(decoded).size).toBe(1);
    const restored = host.decode(runtime.encode(decoded)) as object[];
    expect(original.get(restored[0]!)).toBe("owned");
    expect(() => new WireValues("host").decode(runtime.encode(decoded))).toThrow("stale");
  });
  it("does not allow a peer projection to mutate the original host object", () => {
    const host = new WireValues("host");
    const runtime = new WireValues("runtime");
    const message = { role: "user", content: "original", timestamp: 1 };
    const remote = runtime.decode(host.encode(message)) as typeof message;
    remote.content = "forged";
    expect(host.decode(runtime.encode(remote))).toBe(message);
    expect(message.content).toBe("original");
  });
});
