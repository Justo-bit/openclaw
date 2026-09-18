import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { StartSchema } from "./loop-contract.js";
import type { NativeRuntime } from "./native-runtime.js";
import {
  BUILTIN_RUNTIME_PROTOCOL,
  ClientFrameSchema,
  MAX_FRAME_BYTES,
  decodeRuntimeFrame,
  sameBinding,
  type HostOperation,
  type ServerFrame,
  type TurnBinding,
} from "./protocol.js";
import { runBuiltinRuntimeLoop } from "./server-loop.js";
import { WireValues } from "./wire-values.js";

export type RuntimeConnection = {
  signal: AbortSignal;
  call: (
    operation: HostOperation,
    input: unknown,
    onEvent?: (event: unknown) => Promise<void>,
  ) => Promise<unknown>;
  abort: () => void;
};
export type RuntimeServerOptions = {
  token: string;
  gatewayId: string;
  workspaceIds: readonly string[];
  runtime?: NativeRuntime;
  port?: number;
  host?: "127.0.0.1" | "::1";
  /** Test composition uses the same authenticated transport and lifecycle. */
  run?: (
    input: unknown,
    connection: RuntimeConnection,
  ) => Promise<void | "completed" | "failed" | "cancelled">;
};
/** One server epoch, ephemeral connection/turn state, no workspace or credential store access. */
export async function startBuiltinRuntimeServer(options: RuntimeServerOptions) {
  if (options.token.length < 32 || !options.gatewayId || !options.workspaceIds.length) {
    throw new Error(
      "Runtime requires a token of at least 32 characters and explicit gateway/workspace scopes",
    );
  }
  if (!options.runtime && !options.run) {
    throw new Error("Native inference runtime is required");
  }
  const tokenHash = createHash("sha256").update(options.token).digest();
  const epoch = randomUUID();
  const leases = new Map<string, object>();
  const http = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  http.on("upgrade", (req, socket, head) => {
    const auth = req.headers.authorization;
    if (
      sockets.clients.size >= 128 ||
      req.url !== "/runtime" ||
      req.headers.origin ||
      !auth?.startsWith("Bearer ") ||
      !timingSafeEqual(tokenHash, createHash("sha256").update(auth.slice(7)).digest())
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws));
  });
  sockets.on("connection", (ws) => {
    const connectionId = randomUUID();
    const controller = new AbortController();
    const owner = {};
    let initialized = false;
    let binding: TurnBinding | undefined;
    let terminal = false;
    let requestId = 0;
    let eventSequence = 0;
    let leaseKey: string | undefined;
    const pending = new Map<
      number,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        onEvent?: (event: unknown) => Promise<void>;
        events: Promise<void>;
      }
    >();
    const send = (frame: ServerFrame) => {
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_FRAME_BYTES) {
        throw new Error("Runtime connection unavailable");
      }
      const text = JSON.stringify(frame);
      if (Buffer.byteLength(text) > MAX_FRAME_BYTES) {
        throw new Error("Runtime frame too large");
      }
      ws.send(text);
    };
    const release = () => {
      clearTimeout(handshakeTimeout);
      if (leaseKey && leases.get(leaseKey) === owner) {
        leases.delete(leaseKey);
      }
      for (const wait of pending.values()) {
        wait.reject(new Error("Runtime turn closed"));
      }
      pending.clear();
    };
    const finish = (status: "completed" | "cancelled" | "failed") => {
      if (terminal || !binding) {
        return;
      }
      terminal = true;
      try {
        send({
          type: "terminal",
          binding,
          status,
          ...(status === "failed" ? { error: "Built-in runtime turn failed" } : {}),
        });
      } catch {
        /* Peer owns disconnect outcome. */
      }
      release();
    };
    const fail = (code: "version" | "scope" | "protocol" | "busy") => {
      try {
        send({ type: "error", code, message: "Built-in runtime rejected " + code });
      } catch {
        /* Socket may have closed. */
      }
      controller.abort();
      finish("failed");
      ws.close(1008, code);
    };
    let handshakeTimeout = setTimeout(() => fail("protocol"), 10_000);
    const call: RuntimeConnection["call"] = (operation, input, onEvent) => {
      if (!binding || terminal || controller.signal.aborted || pending.size >= 16) {
        return Promise.reject(new Error("Runtime turn inactive"));
      }
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onEvent, events: Promise.resolve() });
        try {
          send({ type: "call", binding: binding!, id, operation, input });
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error("Runtime send failed"));
        }
      });
    };
    ws.on("message", (data, binary) => {
      try {
        if (binary) {
          throw new Error("Text frames required");
        }
        const parsed = ClientFrameSchema.safeParse(decodeRuntimeFrame(data));
        if (!parsed.success) {
          return fail("protocol");
        }
        const frame = parsed.data;
        if (frame.type === "initialize") {
          if (initialized || binding) {
            return fail("protocol");
          }
          if (frame.gatewayId !== options.gatewayId) {
            return fail("scope");
          }
          if (
            frame.minVersion > BUILTIN_RUNTIME_PROTOCOL ||
            frame.maxVersion < BUILTIN_RUNTIME_PROTOCOL ||
            frame.minVersion > frame.maxVersion
          ) {
            return fail("version");
          }
          initialized = true;
          clearTimeout(handshakeTimeout);
          handshakeTimeout = setTimeout(() => fail("protocol"), 10_000);
          send({ type: "ready", version: BUILTIN_RUNTIME_PROTOCOL, epoch, connectionId });
          return;
        }
        if (!initialized || terminal) {
          return fail("protocol");
        }
        if (frame.type === "start") {
          if (binding) {
            return fail("protocol");
          }
          const b = frame.binding;
          if (
            b.epoch !== epoch ||
            b.connectionId !== connectionId ||
            b.gatewayId !== options.gatewayId ||
            !options.workspaceIds.includes(b.workspaceId)
          ) {
            return fail("scope");
          }
          leaseKey = JSON.stringify([b.gatewayId, b.sessionId]);
          if (leases.has(leaseKey)) {
            return fail("busy");
          }
          leases.set(leaseKey, owner);
          binding = b;
          clearTimeout(handshakeTimeout);
          const connection: RuntimeConnection = {
            signal: controller.signal,
            call,
            abort: () => {
              controller.abort();
              finish("failed");
              ws.close(1011, "native execution interrupted");
            },
          };
          const run = async () => {
            if (options.run) {
              return options.run(frame.input, connection);
            }
            const start = StartSchema.parse(new WireValues("runtime").decode(frame.input));
            if (!options.runtime) {
              throw new Error("Native inference runtime unavailable");
            }
            return options.runtime.withTurn({ binding: b, selection: start.selection }, (native) =>
              runBuiltinRuntimeLoop(frame.input, connection, native),
            );
          };
          void run().then(
            (outcome) => finish(controller.signal.aborted ? "cancelled" : (outcome ?? "completed")),
            () => finish(controller.signal.aborted ? "cancelled" : "failed"),
          );
          return;
        }
        if (!binding || !sameBinding(binding, frame.binding)) {
          return fail("scope");
        }
        if (frame.type === "cancel") {
          controller.abort();
          // Reject outstanding effects so a disconnected or stuck host cannot retain a runtime turn.
          for (const wait of pending.values()) {
            wait.reject(new Error("Runtime turn cancelled"));
          }
          pending.clear();
          finish("cancelled");
          return;
        }
        if (frame.type === "event") {
          if (frame.sequence !== eventSequence + 1) {
            return fail("protocol");
          }
          const pendingCall = pending.get(frame.id);
          if (!pendingCall?.onEvent) {
            return fail("protocol");
          }
          eventSequence = frame.sequence;
          const onEvent = pendingCall.onEvent;
          pendingCall.events = pendingCall.events.then(() => onEvent(frame.event));
          void pendingCall.events.catch(() => fail("protocol"));
          return;
        }
        const wait = pending.get(frame.id);
        if (!wait) {
          return fail("protocol");
        }
        pending.delete(frame.id);
        if (frame.error !== undefined) {
          wait.reject(new Error("Host operation failed"));
        } else {
          void wait.events.then(
            () => wait.resolve(frame.value),
            () => {
              wait.reject(new Error("Host tool event failed"));
              fail("protocol");
            },
          );
        }
      } catch {
        fail("protocol");
      }
    });
    ws.on("close", () => {
      controller.abort();
      release();
    });
    ws.on("error", () => {
      controller.abort();
      release();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === "string") {
    throw new Error("Runtime listener unavailable");
  }
  return {
    epoch,
    port: address.port,
    close: async () => {
      options.runtime?.close();
      for (const ws of sockets.clients) {
        ws.terminate();
      }
      await new Promise<void>((resolve) => {
        sockets.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
