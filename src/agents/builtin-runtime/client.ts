import { WebSocket } from "ws";
import {
  assertRuntimeUrl,
  BUILTIN_RUNTIME_PROTOCOL,
  MAX_FRAME_BYTES,
  decodeRuntimeFrame,
  sameBinding,
  ServerFrameSchema,
  TurnIdentitySchema,
  type ClientFrame,
  type HostOperation,
  type Terminal,
  type TurnBinding,
  type TurnIdentity,
} from "./protocol.js";

export type RuntimeClientOptions = {
  url: string;
  token: string;
  identity: TurnIdentity;
  signal: AbortSignal;
  assertActive: () => void;
  input: unknown;
  host: (
    operation: HostOperation,
    input: unknown,
    signal: AbortSignal,
    publish: (event: unknown) => void,
  ) => Promise<unknown>;
  onTerminal?: (terminal: Terminal) => void;
};
const activeSessions = new Set<string>();
/** No reconnect/retry: a replacement connection can never replay an in-flight effect. */
export async function runBuiltinRuntimeClient(options: RuntimeClientOptions): Promise<Terminal> {
  assertRuntimeUrl(options.url);
  TurnIdentitySchema.parse(options.identity);
  if (options.token.length < 32) {
    throw new Error("Built-in runtime token must contain at least 32 characters");
  }
  options.signal.throwIfAborted();
  options.assertActive();
  const key = JSON.stringify([options.identity.gatewayId, options.identity.sessionId]);
  if (activeSessions.has(key)) {
    throw new Error("Previous built-in runtime turn is still settling");
  }
  const disconnected = new AbortController();
  const signal = AbortSignal.any([options.signal, disconnected.signal]);
  const tasks = new Set<Promise<void>>();
  const ws = new WebSocket(options.url, {
    headers: { Authorization: "Bearer " + options.token },
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
    followRedirects: false,
  });
  activeSessions.add(key);
  let binding: TurnBinding | undefined;
  let nextCallId = 1;
  let eventSequence = 0;
  let terminal: Terminal | undefined;
  let resolveDone: (value: Terminal) => void;
  let rejectDone: (error: Error) => void;
  const done = new Promise<Terminal>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const send = (frame: ClientFrame) => {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_FRAME_BYTES) {
      throw new Error("Built-in runtime connection unavailable");
    }
    const data = JSON.stringify(frame);
    if (Buffer.byteLength(data) > MAX_FRAME_BYTES) {
      throw new Error("Built-in runtime frame too large");
    }
    ws.send(data);
  };
  const settle = (result: Terminal) => {
    if (terminal) {
      return;
    }
    terminal = result;
    resolveDone(result);
  };
  const fail = () => {
    disconnected.abort();
    if (binding) {
      settle({
        type: "terminal",
        binding,
        status: options.signal.aborted ? "cancelled" : "failed",
        error: "Built-in runtime disconnected; interrupted turns are not resumed",
      });
    } else {
      rejectDone(new Error("Built-in runtime connection or negotiation failed"));
    }
    ws.terminate();
  };
  const cancel = () => {
    if (binding && !terminal) {
      try {
        send({ type: "cancel", binding });
      } catch {
        /* Local settlement is authoritative after disconnect. */
      }
      settle({ type: "terminal", binding, status: "cancelled" });
    } else if (!terminal) {
      rejectDone(new Error("Built-in runtime connection cancelled"));
    }
    ws.terminate();
  };
  const initializationTimeout = setTimeout(fail, 10_000);
  options.signal.addEventListener("abort", cancel, { once: true });
  ws.on("open", () => {
    try {
      options.assertActive();
      send({
        type: "initialize",
        minVersion: BUILTIN_RUNTIME_PROTOCOL,
        maxVersion: BUILTIN_RUNTIME_PROTOCOL,
        gatewayId: options.identity.gatewayId,
      });
    } catch {
      fail();
    }
  });
  ws.on("message", (data, binary) => {
    try {
      if (binary) {
        return fail();
      }
      const parsed = ServerFrameSchema.safeParse(decodeRuntimeFrame(data));
      if (!parsed.success) {
        return fail();
      }
      const frame = parsed.data;
      if (frame.type === "error") {
        return fail();
      }
      if (frame.type === "ready") {
        if (binding || terminal) {
          return fail();
        }
        binding = { ...options.identity, epoch: frame.epoch, connectionId: frame.connectionId };
        options.assertActive();
        signal.throwIfAborted();
        send({ type: "start", binding, input: options.input });
        clearTimeout(initializationTimeout);
        return;
      }
      if (!binding || !sameBinding(binding, frame.binding) || terminal) {
        return fail();
      }
      if (frame.type === "terminal") {
        if (frame.status === "completed" && tasks.size > 0) {
          return fail();
        }
        settle(frame);
        return;
      }
      if (frame.id !== nextCallId++ || tasks.size >= 16) {
        return fail();
      }
      const currentBinding = binding;
      const task = (async () => {
        try {
          signal.throwIfAborted();
          options.assertActive();
          const value = await options.host(frame.operation, frame.input, signal, (event) => {
            if (signal.aborted || terminal || binding !== currentBinding) {
              return;
            }
            send({
              type: "event",
              binding: currentBinding,
              sequence: ++eventSequence,
              id: frame.id,
              event,
            });
          });
          // Authority is checked again after hooks/approvals, before returning an effect result.
          signal.throwIfAborted();
          options.assertActive();
          if (terminal || binding !== currentBinding) {
            return;
          }
          send({ type: "result", binding: currentBinding, id: frame.id, value });
        } catch {
          if (!terminal && !signal.aborted) {
            try {
              send({
                type: "result",
                binding: currentBinding,
                id: frame.id,
                error: "Host operation failed",
              });
            } catch {
              fail();
            }
          }
        }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    } catch {
      fail();
    }
  });
  ws.on("error", fail);
  ws.on("close", () => {
    if (!terminal) {
      fail();
    }
  });
  try {
    const result = await done;
    if (result.status !== "completed") {
      disconnected.abort();
    }
    return result;
  } finally {
    clearTimeout(initializationTimeout);
    options.signal.removeEventListener("abort", cancel);
    disconnected.abort();
    ws.terminate();
    // Retain the local session fence until every already-started host effect settles.
    await Promise.allSettled(tasks);
    activeSessions.delete(key);
    if (terminal) {
      try {
        options.onTerminal?.(terminal);
      } catch {
        /* Observers do not own settlement. */
      }
    }
  }
}
