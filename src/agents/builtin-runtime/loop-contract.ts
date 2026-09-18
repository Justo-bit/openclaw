import { z } from "zod";
import type { ExecutedToolCallBatch } from "../../../packages/agent-core/src/agent-stream-response.js";
import type { LoopToolsInput } from "../../../packages/agent-core/src/loop-host.js";
import type {
  AgentContext,
  AgentEvent,
  AgentMessage,
  PrepareNextTurnContext,
} from "../../../packages/agent-core/src/types.js";
import type { AssistantMessage, Message } from "../../llm/types.js";

const record = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = z.looseObject({ type: z.literal("text"), text: z.string() });
const image = z.looseObject({ type: z.literal("image"), data: z.string(), mimeType: z.string() });
const toolCall = z.looseObject({
  type: z.literal("toolCall"),
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(256),
  arguments: z.unknown(),
  async: z.boolean().optional(),
});
const assistantData = z.looseObject({
  role: z.literal("assistant"),
  api: z.string(),
  provider: z.string(),
  model: z.string(),
  content: z.array(
    z.union([text, z.looseObject({ type: z.literal("thinking"), thinking: z.string() }), toolCall]),
  ),
  stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
  timestamp: z.number().finite(),
  responseId: z.string().max(1024).optional(),
  turnId: z.string().max(1024).optional(),
  endTurn: z.boolean().optional(),
  errorMessage: z.string().optional(),
  errorCode: z.string().optional(),
  usage: z.looseObject({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    totalTokens: z.number(),
    cost: z.looseObject({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
      total: z.number(),
    }),
  }),
});
/** Validate without cloning: host transcript provenance depends on exact object identity. */
export const AssistantSchema = z.custom<AssistantMessage>(
  (v) => assistantData.safeParse(v).success,
);
const userData = z.looseObject({
  role: z.literal("user"),
  content: z.union([z.string(), z.array(z.union([text, image]))]),
  timestamp: z.number(),
});
const resultData = z.looseObject({
  role: z.literal("toolResult"),
  toolCallId: z.string(),
  toolName: z.string(),
  content: z.array(z.union([text, image])),
  isError: z.boolean(),
  timestamp: z.number(),
});
export const LlmMessageSchema = z.custom<Message>(
  (v) =>
    userData.safeParse(v).success ||
    assistantData.safeParse(v).success ||
    resultData.safeParse(v).success,
);
export const MessageSchema = z.custom<AgentMessage>(
  (v) =>
    LlmMessageSchema.safeParse(v).success ||
    (record(v) &&
      typeof v.role === "string" &&
      ["custom", "bashExecution", "branchSummary", "compactionSummary"].includes(v.role)),
);
const toolData = z.strictObject({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  executionMode: z.enum(["parallel", "sequential"]).optional(),
  hideFromChannelProgress: z.boolean().optional(),
  resultContentSource: z.literal("network").optional(),
});
const contextData = z.strictObject({
  systemPrompt: z.string(),
  messages: z.array(MessageSchema),
  tools: z.array(toolData).optional(),
});
const WireContextSchema = z.custom<AgentContext>((v) => contextData.safeParse(v).success);
export const ContextSchema = z.custom<AgentContext>(
  (v) =>
    record(v) &&
    typeof v.systemPrompt === "string" &&
    Array.isArray(v.messages) &&
    (v.tools === undefined || Array.isArray(v.tools)),
);
export const SelectionSchema = z.strictObject({
  provider: z.string().min(1).max(256),
  modelId: z.string().min(1).max(256),
});
export const ThinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const StartSchema = z.strictObject({
  selection: SelectionSchema,
  context: WireContextSchema,
  prompts: z.array(MessageSchema).optional(),
  thinkingLevel: ThinkingSchema.optional(),
  criticalToolLoopSeen: z.boolean(),
  shouldStop: z.boolean(),
});
const eventData = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("agent_start") }),
  z.strictObject({ type: z.literal("agent_end"), messages: z.array(MessageSchema) }),
  z.strictObject({ type: z.literal("turn_start") }),
  z.strictObject({
    type: z.literal("turn_end"),
    message: MessageSchema,
    toolResults: z.array(MessageSchema),
  }),
  z.strictObject({ type: z.literal("message_start"), message: MessageSchema }),
  z.strictObject({ type: z.literal("message_end"), message: MessageSchema }),
  z.strictObject({
    type: z.literal("message_update"),
    message: AssistantSchema,
    assistantMessageEvent: z.record(z.string(), z.unknown()),
  }),
  z.looseObject({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
  }),
  z.looseObject({
    type: z.literal("tool_execution_update"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
    partialResult: z.unknown(),
  }),
  z.looseObject({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    toolName: z.string(),
    result: z.unknown(),
    isError: z.boolean(),
  }),
]);
export const EventSchema = z.custom<AgentEvent>((v) => eventData.safeParse(v).success);
export const EventRequestSchema = z.strictObject({
  event: EventSchema,
  turn: z.number().int().nonnegative(),
  messageId: z.string().max(256).optional(),
});
export const ContextRequestSchema = z.strictObject({ turn: z.number().int().positive() });
export const ToolsInputSchema = z.custom<LoopToolsInput>(
  (v) =>
    record(v) &&
    ContextSchema.safeParse(v.context).success &&
    AssistantSchema.safeParse(v.message).success &&
    Array.isArray(v.calls) &&
    v.calls.every((call) => toolCall.safeParse(call).success) &&
    Array.isArray(v.steeringMessages) &&
    typeof v.criticalToolLoopSeen === "boolean" &&
    typeof v.hasStreamedTools === "boolean",
);
export const ToolsRequestSchema = z.strictObject({
  batch: ToolsInputSchema,
  turn: z.number().int().positive(),
});
export const BatchSchema = z.custom<ExecutedToolCallBatch>(
  (v) =>
    record(v) &&
    Array.isArray(v.messages) &&
    v.messages.every((message) => resultData.safeParse(message).success) &&
    Array.isArray(v.steeringMessages) &&
    typeof v.terminate === "boolean" &&
    typeof v.terminateRun === "boolean",
);
export const PrepareSchema = z.custom<PrepareNextTurnContext>(
  (v) =>
    record(v) &&
    ContextSchema.safeParse(v.context).success &&
    MessageSchema.safeParse(v.message).success &&
    Array.isArray(v.toolResults) &&
    Array.isArray(v.newMessages),
);
export const UpdateSchema = z
  .strictObject({
    context: WireContextSchema.optional(),
    selection: SelectionSchema.optional(),
    thinkingLevel: ThinkingSchema.optional(),
    stop: z.boolean().optional(),
  })
  .optional();
