import { isDeepStrictEqual } from "node:util";
import { runLoopHostTools } from "../../../packages/agent-core/src/agent-loop.js";
import type { LoopInvocation } from "../../../packages/agent-core/src/loop-host.js";
import { normalizeCoreContextMessages } from "../../../packages/agent-core/src/turn-interruption.js";
import type {
  AgentContext,
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolCall,
} from "../../../packages/agent-core/src/types.js";
import type { AssistantMessage } from "../../llm/types.js";
import { runBuiltinRuntimeClient, type RuntimeClientOptions } from "./client.js";
import {
  AssistantSchema,
  ContextRequestSchema,
  EventRequestSchema,
  LlmMessageSchema,
  MessageSchema,
  PrepareSchema,
  ToolsRequestSchema,
} from "./loop-contract.js";
import { WireValues } from "./wire-values.js";

export type RemoteLoopOptions = Pick<
  RuntimeClientOptions,
  "url" | "token" | "identity" | "assertActive" | "onTerminal"
>;

/** Gateway-owned transcript and tool authority. There is deliberately no provider callback here. */
export async function runRemoteBuiltinLoop(
  invocation: LoopInvocation,
  options: RemoteLoopOptions,
): Promise<void> {
  const values = new WireValues("host");
  const contexts = new WeakSet<AgentContext>();
  const newMessages: AgentMessage[] = [];
  let context = invocation.context;
  let config = invocation.config;
  let selection = { provider: config.model.provider, modelId: config.model.id };
  let turn = 0;
  let started = false;
  let turnOpen = false;
  let prepared = true;
  let preparing = false;
  let toolsBusy = false;
  let handoffStop = false;
  let terminalRecovery = false;
  const reservedCallIds = new Set<string>();
  let lastNative: AssistantMessage | undefined;
  let pendingEnd: Extract<AgentEvent, { type: "agent_end" }> | undefined;
  let toolResults: AgentMessage[] = [];
  let pendingSteering: AgentMessage[] = [];
  const eligible = new WeakSet<object>(invocation.prompts ?? []);
  const committed = new WeakSet<object>(context.messages);
  const queuedPhases = new WeakMap<object, "started" | "ended">();
  const nativeMessages = new Map<string, "started" | "ended">();
  const nativeTurns = new WeakMap<object, number>();
  let activeNativeId: string | undefined;
  const calls = new Map<
    string,
    { call: AgentToolCall; message: AssistantMessage; turn: number; used: boolean }
  >();
  const bindTool = (tool: AgentTool) =>
    values.bind(tool, {
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      executionMode: tool.executionMode,
      hideFromChannelProgress: tool.hideFromChannelProgress,
      resultContentSource: tool.resultContentSource,
    });
  const bindContext = (value: AgentContext) => {
    for (const tool of value.tools ?? []) {
      bindTool(tool);
    }
    values.bind(value);
    contexts.add(value);
  };
  const assertContext = (value: AgentContext) => {
    if (value !== context || !contexts.has(value)) {
      throw new Error("Runtime context ownership changed");
    }
  };
  const commit = (message: AgentMessage) => {
    if (committed.has(message)) {
      throw new Error("Duplicate transcript commit");
    }
    committed.add(message);
    context.messages.push(message);
    newMessages.push(message);
  };
  bindContext(context);
  const terminal = await runBuiltinRuntimeClient({
    ...options,
    onTerminal: undefined,
    signal: invocation.signal,
    input: values.encode({
      prompts: invocation.prompts,
      context,
      selection,
      thinkingLevel: config.thinkingLevel,
      criticalToolLoopSeen: config.toolLoopRecoveryState?.criticalToolLoopSeen ?? false,
      shouldStop: Boolean(config.shouldStopAfterTurn),
    }),
    host: async (operation, wireInput, signal, publish) => {
      const input = values.decode(wireInput);
      signal.throwIfAborted();
      options.assertActive();
      if (pendingEnd) {
        throw new Error("Runtime operation after terminal event");
      }
      switch (operation) {
        case "event": {
          const request = EventRequestSchema.parse(input);
          const { event, messageId } = request;
          if (event.type === "agent_start") {
            if (started || request.turn !== 0) {
              throw new Error("Duplicate runtime start");
            }
            started = true;
          } else if (!started) {
            throw new Error("Runtime event before start");
          }
          if (event.type === "turn_start") {
            if (
              turnOpen ||
              toolsBusy ||
              (!prepared && !terminalRecovery) ||
              handoffStop ||
              request.turn !== turn + 1
            ) {
              throw new Error("Runtime turn out of order");
            }
            turn = request.turn;
            turnOpen = true;
            prepared = false;
            toolResults = [];
            lastNative = undefined;
          } else if (request.turn !== turn) {
            throw new Error("Stale runtime event turn");
          }
          if (
            event.type.startsWith("tool_execution_") ||
            ((event.type === "message_start" || event.type === "message_end") &&
              event.message.role === "toolResult")
          ) {
            throw new Error("Tool outcomes must originate from Gateway execution");
          }
          if (
            event.type === "message_start" ||
            event.type === "message_update" ||
            event.type === "message_end"
          ) {
            if (event.message.role === "assistant") {
              const message = AssistantSchema.parse(event.message);
              if (
                !turnOpen ||
                !messageId ||
                values.owns(message) ||
                message.provider !== selection.provider ||
                message.model !== selection.modelId
              ) {
                throw new Error("Invalid native model event");
              }
              if (event.type === "message_start") {
                if (activeNativeId || nativeMessages.has(messageId)) {
                  throw new Error("Duplicate native message start");
                }
                activeNativeId = messageId;
                nativeMessages.set(messageId, "started");
              } else if (
                activeNativeId !== messageId ||
                nativeMessages.get(messageId) !== "started"
              ) {
                throw new Error("Native message out of order");
              }
              if (event.type === "message_end") {
                nativeMessages.set(messageId, "ended");
                const proposedIds = new Set<string>();
                for (const call of message.content) {
                  if (call.type !== "toolCall") {
                    continue;
                  }
                  if (reservedCallIds.has(call.id)) {
                    throw new Error("Duplicate native tool call identifier");
                  }
                  reservedCallIds.add(call.id);
                  proposedIds.add(call.id);
                }
                // Agent.processEvents appends before awaiting listeners. Match that acceptance order.
                commit(message);
                await invocation.emit(event);
                signal.throwIfAborted();
                options.assertActive();
                if (event.message !== message) {
                  throw new Error("Native finalization replaced the message owner");
                }
                AssistantSchema.parse(message);
                const finalizedIds = new Set<string>();
                for (const call of message.content) {
                  if (call.type !== "toolCall") {
                    continue;
                  }
                  if (
                    terminalRecovery ||
                    finalizedIds.has(call.id) ||
                    (!proposedIds.has(call.id) && reservedCallIds.has(call.id))
                  ) {
                    throw new Error("Invalid finalized native tool call");
                  }
                  finalizedIds.add(call.id);
                  reservedCallIds.add(call.id);
                  calls.set(call.id, { call, message, turn, used: false });
                }
                activeNativeId = undefined;
                nativeTurns.set(message, turn);
                lastNative = message;
                return values.encode(message);
              }
            } else {
              if (
                event.type === "message_update" ||
                (!turnOpen && !handoffStop) ||
                !eligible.has(event.message) ||
                !values.owns(event.message)
              ) {
                throw new Error("Runtime message lacks admitted host provenance");
              }
              const phase = queuedPhases.get(event.message);
              if (event.type === "message_start" ? phase !== undefined : phase !== "started") {
                throw new Error("Duplicate queued message");
              }
              queuedPhases.set(event.message, event.type === "message_start" ? "started" : "ended");
              if (event.type === "message_end") {
                commit(event.message);
                await invocation.emit(event);
                pendingSteering = pendingSteering.filter((message) => message !== event.message);
                return values.encode(undefined);
              }
            }
          }
          if (event.type === "turn_end") {
            if (
              !turnOpen ||
              toolsBusy ||
              activeNativeId ||
              event.message !== lastNative ||
              !isDeepStrictEqual(event.toolResults, toolResults)
            ) {
              throw new Error("Invalid runtime turn outcome");
            }
            turnOpen = false;
          }
          if (event.type === "agent_end") {
            if (
              toolsBusy ||
              activeNativeId ||
              (turnOpen && newMessages.length > 0) ||
              event.messages.length !== newMessages.length ||
              new Set(event.messages).size !== newMessages.length ||
              event.messages.some((message) => !newMessages.includes(message))
            ) {
              throw new Error("Invalid runtime terminal event");
            }
            pendingEnd = event;
            return values.encode(newMessages);
          }
          await invocation.emit(event);

          return values.encode(undefined);
        }
        case "modelContext": {
          const request = ContextRequestSchema.parse(input);
          if (
            !turnOpen ||
            handoffStop ||
            terminalRecovery ||
            request.turn !== turn ||
            activeNativeId
          ) {
            throw new Error("Model context requested outside admitted turn");
          }
          const projected = config.transformContext
            ? await config.transformContext(context.messages.slice(), signal)
            : context.messages.slice();
          signal.throwIfAborted();
          options.assertActive();
          return values.encode(
            LlmMessageSchema.array().parse(
              await config.convertToLlm(normalizeCoreContextMessages(projected)),
            ),
          );
        }
        case "tools": {
          const request = ToolsRequestSchema.parse(input);
          const batch = request.batch;
          assertContext(batch.context);
          if (
            request.turn !== turn ||
            !turnOpen ||
            terminalRecovery ||
            toolsBusy ||
            nativeTurns.get(batch.message) !== turn ||
            batch.calls.length === 0
          ) {
            throw new Error("Tool batch has no current persisted native message");
          }
          const entries = batch.calls.map((call) => {
            const entry = calls.get(call.id);
            if (
              !entry ||
              entry.turn !== turn ||
              entry.used ||
              entry.message !== batch.message ||
              !isDeepStrictEqual(entry.call, call)
            ) {
              throw new Error("Stale, changed, or duplicate native tool call");
            }
            return entry;
          });
          if (new Set(entries).size !== entries.length) {
            throw new Error("Duplicate tool call in batch");
          }
          for (const entry of entries) {
            entry.used = true;
          }
          toolsBusy = true;
          try {
            const result = await runLoopHostTools(
              {
                ...batch,
                context,
                calls: entries.map((entry) => entry.call),
                steeringMessages: pendingSteering,
                criticalToolLoopSeen: config.toolLoopRecoveryState?.criticalToolLoopSeen ?? false,
              },
              {
                config,
                signal,
                emit: async (event) => {
                  if (event.type === "message_end") {
                    commit(event.message);
                  }
                  await invocation.emit(event);
                  publish(values.encode(event));
                },
              },
            );
            if (result.terminateRun) {
              terminalRecovery = true;
            }
            toolResults.push(...result.messages);
            for (const message of result.steeringMessages) {
              eligible.add(message);
            }
            pendingSteering = result.steeringMessages;
            if (result.intervention && config.toolLoopRecoveryState) {
              config.toolLoopRecoveryState.criticalToolLoopSeen = true;
            }
            return values.encode(result);
          } finally {
            toolsBusy = false;
          }
        }
        case "consumeCancellation":
          return values.encode(
            config.consumeQueuedMessageCancellation?.(MessageSchema.parse(input)) ?? false,
          );
        case "steering":
        case "followUp": {
          const messages =
            (await (operation === "steering"
              ? config.getSteeringMessages?.()
              : config.getFollowUpMessages?.())) ?? [];
          for (const message of messages) {
            eligible.add(message);
          }
          return values.encode(messages);
        }
        case "prepareNextTurn": {
          const request = PrepareSchema.parse(input);
          assertContext(request.context);
          if (
            turnOpen ||
            terminalRecovery ||
            toolsBusy ||
            preparing ||
            prepared ||
            request.message !== lastNative
          ) {
            throw new Error("Runtime preparation out of order");
          }
          preparing = true;
          try {
            const update = await config.prepareNextTurn?.({
              ...request,
              context,
              newMessages,
              toolResults: toolResults.filter((message) => message.role === "toolResult"),
            });
            if (update?.context) {
              context = update.context;
              bindContext(context);
            }
            if (update?.model) {
              selection = { provider: update.model.provider, modelId: update.model.id };
              config = { ...config, model: update.model };
            }
            handoffStop = update?.stop === true;
            prepared = true;
            return values.encode(
              update
                ? {
                    context: update.context,
                    selection: update.model ? selection : undefined,
                    thinkingLevel: update.thinkingLevel,
                    stop: update.stop,
                  }
                : undefined,
            );
          } finally {
            preparing = false;
          }
        }
        case "shouldStop": {
          const request = PrepareSchema.parse(input);
          assertContext(request.context);
          if (!prepared || turnOpen || request.message !== lastNative || handoffStop) {
            throw new Error("Runtime stop hook out of order");
          }
          return values.encode(
            (await config.shouldStopAfterTurn?.({
              ...request,
              context,
              newMessages,
              toolResults: toolResults.filter((message) => message.role === "toolResult"),
            })) ?? false,
          );
        }
      }
      throw new Error("Unsupported native runtime host operation");
    },
  });
  const providerTerminal =
    pendingEnd && (lastNative?.stopReason === "error" || lastNative?.stopReason === "aborted");
  const outcome =
    terminal.status === "completed" && !pendingEnd
      ? {
          ...terminal,
          status: "failed" as const,
          error: "Runtime ended without a terminal loop event",
        }
      : terminal;
  try {
    options.onTerminal?.(outcome);
  } catch {
    /* Observers do not own settlement. */
  }
  if (!pendingEnd || (outcome.status !== "completed" && !providerTerminal)) {
    throw new Error(outcome.error ?? "Native runtime turn interrupted");
  }
  options.assertActive();
  await invocation.emit({ ...pendingEnd, messages: newMessages });
}
