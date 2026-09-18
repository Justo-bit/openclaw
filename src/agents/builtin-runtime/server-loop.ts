import { getSupportedThinkingLevels } from "@openclaw/ai/internal/runtime";
import { runAgentLoop, runAgentLoopContinue } from "../../../packages/agent-core/src/agent-loop.js";
import { setAgentLoopHost } from "../../../packages/agent-core/src/loop-host.js";
import { resolveAgentReasoningOption } from "../../../packages/agent-core/src/reasoning.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
} from "../../../packages/agent-core/src/types.js";
import {
  AssistantSchema,
  BatchSchema,
  EventSchema,
  LlmMessageSchema,
  MessageSchema,
  StartSchema,
  UpdateSchema,
} from "./loop-contract.js";
import type { NativeRuntimeResolved } from "./native-runtime.js";
import { MAX_FRAME_BYTES, type HostOperation } from "./protocol.js";
import type { RuntimeConnection } from "./server.js";
import { WireValues } from "./wire-values.js";

/** The provider stream and the shared native agent loop both execute in this process. */
export async function runBuiltinRuntimeLoop(
  input: unknown,
  connection: RuntimeConnection,
  native: NativeRuntimeResolved,
): Promise<"completed" | "failed" | "cancelled"> {
  const values = new WireValues("runtime");
  const start = StartSchema.parse(values.decode(input));
  let turn = 0;
  let nextMessage = 0;
  let activeMessageId: string | undefined;
  const completedBlocks = new Set<number>();
  let outcome: "completed" | "failed" | "cancelled" = "completed";
  const hostEvents = new WeakSet<object>();
  let pendingUpdates: unknown[] = [];
  let pendingUpdateBytes = 0;
  const sendPayload = async (
    operation: HostOperation,
    payload: unknown,
    onEvent?: (event: unknown) => Promise<void>,
  ) => {
    connection.signal.throwIfAborted();
    native.assertProtocolSafe(payload);
    return values.decode(await connection.call(operation, payload, onEvent));
  };
  const call = (
    operation: HostOperation,
    value?: unknown,
    onEvent?: (event: unknown) => Promise<void>,
  ) => sendPayload(operation, values.encode(value), onEvent);
  const prepareContext = (context: AgentContext) => {
    // Descriptors become non-executable runtime tools. Every execution path is delegated to the host batch owner.
    for (const tool of context.tools ?? []) {
      tool.execute = async () => {
        throw new Error("Native runtime tools require Gateway execution");
      };
    }
    return context;
  };
  const emit = async (event: AgentEvent) => {
    if (hostEvents.has(event)) {
      return;
    }
    if (event.type === "turn_start") {
      turn++;
    }
    let messageId: string | undefined;
    if (
      (event.type === "message_start" ||
        event.type === "message_update" ||
        event.type === "message_end") &&
      event.message.role === "assistant"
    ) {
      if (event.type === "message_start") {
        activeMessageId = String(++nextMessage);
        completedBlocks.clear();
      }
      messageId = activeMessageId;
      if (event.type === "message_end") {
        if (event.message.stopReason === "error") {
          outcome = "failed";
        }
        if (event.message.stopReason === "aborted") {
          outcome = "cancelled";
        }
      }
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (
        update.type === "text_end" ||
        update.type === "thinking_end" ||
        update.type === "toolcall_end"
      ) {
        completedBlocks.add(update.contentIndex);
      }
    }
    const payload = values.encode({ event, turn, messageId });
    native.assertProtocolSafe(payload);
    // Model snapshots carry cumulative content. Keep observations private while a
    // suffix may become a credential; validate the resolving snapshot before release.
    if (
      (event.type === "message_start" || event.type === "message_update") &&
      event.message.role === "assistant" &&
      event.message.content.some(
        (block, index) =>
          !completedBlocks.has(index) &&
          native.hasCredentialPrefix(
            block.type === "text"
              ? block.text
              : block.type === "thinking"
                ? block.thinking
                : block.arguments,
          ),
      )
    ) {
      pendingUpdateBytes += Buffer.byteLength(JSON.stringify(payload));
      if (pendingUpdateBytes > MAX_FRAME_BYTES) {
        throw new Error("Native credential-prefix buffer exceeded");
      }
      pendingUpdates.push(payload);
      return;
    }
    if (pendingUpdates.length > 0) {
      if (
        (event.type !== "message_update" && event.type !== "message_end") ||
        event.message.role !== "assistant" ||
        event.message.stopReason === "error" ||
        event.message.stopReason === "aborted"
      ) {
        throw new Error("Native stream ended with an unresolved credential prefix");
      }
      const pending = pendingUpdates;
      pendingUpdates = [];
      pendingUpdateBytes = 0;
      for (const update of pending) {
        await sendPayload("event", update);
      }
    }
    const acknowledgement = await sendPayload("event", payload);
    if (event.type === "agent_end") {
      const messages = MessageSchema.array().parse(acknowledgement);
      event.messages.splice(0, event.messages.length, ...messages);
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const message = AssistantSchema.parse(acknowledgement);
      values.adoptReference(event.message, message);
      activeMessageId = undefined;
    }
  };
  const validateThinkingLevel = (level: AgentLoopConfig["thinkingLevel"]) => {
    if (level !== undefined && !getSupportedThinkingLevels(native.model).includes(level)) {
      throw new Error("Unsupported native thinking level: " + level);
    }
    return level;
  };
  const thinkingLevel = validateThinkingLevel(start.thinkingLevel ?? "off");
  const config: AgentLoopConfig = {
    model: native.model,
    thinkingLevel,
    reasoning: resolveAgentReasoningOption(native.model, thinkingLevel ?? "off"),
    toolLoopRecoveryState: { criticalToolLoopSeen: start.criticalToolLoopSeen },
    convertToLlm: async () => LlmMessageSchema.array().parse(await call("modelContext", { turn })),
    getSteeringMessages: async () => MessageSchema.array().parse(await call("steering")),
    getFollowUpMessages: async () => MessageSchema.array().parse(await call("followUp")),
    prepareNextTurn: async (context) => {
      const update = UpdateSchema.parse(await call("prepareNextTurn", context));
      if (
        update?.selection &&
        (update.selection.provider !== start.selection.provider ||
          update.selection.modelId !== start.selection.modelId)
      ) {
        throw new Error("Native runtime model changes require a newly admitted turn");
      }
      return update
        ? {
            stop: update.stop,
            thinkingLevel: validateThinkingLevel(update.thinkingLevel),
            context: update.context ? prepareContext(update.context) : undefined,
          }
        : undefined;
    },
    ...(start.shouldStop
      ? { shouldStopAfterTurn: async (context) => (await call("shouldStop", context)) === true }
      : {}),
  };
  setAgentLoopHost(config, {
    consumeCancellation: async (message) => (await call("consumeCancellation", message)) === true,
    tools: async (batch, toolEmit, signal) => {
      signal?.throwIfAborted();
      const abort = () => {
        if (!connection.signal.aborted) {
          connection.abort();
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        return BatchSchema.parse(
          await call("tools", { batch, turn }, async (payload) => {
            const event = EventSchema.parse(values.decode(payload));
            hostEvents.add(event);
            await toolEmit(event);
          }),
        );
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  });
  const context = prepareContext(start.context);
  if (start.prompts) {
    await runAgentLoop(start.prompts, context, config, emit, connection.signal, native.streamFn);
  } else {
    await runAgentLoopContinue(context, config, emit, connection.signal, native.streamFn);
  }
  return outcome;
}
