import type { RawData } from "ws";
import { z } from "zod";

export const BUILTIN_RUNTIME_PROTOCOL = 1;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const id = z.string().min(1).max(256);
export const TurnIdentitySchema = z.strictObject({
  gatewayId: id,
  workspaceId: id,
  sessionId: id,
  runId: id,
  attemptId: id,
});
export type TurnIdentity = z.infer<typeof TurnIdentitySchema>;
export const BindingSchema = TurnIdentitySchema.extend({ epoch: id, connectionId: id });
export type TurnBinding = z.infer<typeof BindingSchema>;
export const HostOperationSchema = z.enum([
  "event",
  "modelContext",
  "tools",
  "consumeCancellation",
  "steering",
  "followUp",
  "prepareNextTurn",
  "shouldStop",
]);
export type HostOperation = z.infer<typeof HostOperationSchema>;
export const ClientFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("initialize"),
    minVersion: z.number().int().nonnegative(),
    maxVersion: z.number().int().nonnegative(),
    gatewayId: id,
  }),
  z.strictObject({ type: z.literal("start"), binding: BindingSchema, input: z.unknown() }),
  z.strictObject({
    type: z.literal("result"),
    binding: BindingSchema,
    id: z.number().int().positive(),
    value: z.unknown().optional(),
    error: z.string().max(4096).optional(),
  }),
  z.strictObject({ type: z.literal("cancel"), binding: BindingSchema }),
  z.strictObject({
    type: z.literal("event"),
    binding: BindingSchema,
    sequence: z.number().int().positive(),
    id: z.number().int().positive(),
    event: z.unknown(),
  }),
]);
export const ServerFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ready"),
    version: z.literal(BUILTIN_RUNTIME_PROTOCOL),
    epoch: id,
    connectionId: id,
  }),
  z.strictObject({
    type: z.literal("call"),
    binding: BindingSchema,
    id: z.number().int().positive(),
    operation: HostOperationSchema,
    input: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("terminal"),
    binding: BindingSchema,
    status: z.enum(["completed", "cancelled", "failed"]),
    error: z.string().max(4096).optional(),
  }),
  z.strictObject({
    type: z.literal("error"),
    code: z.enum(["version", "scope", "protocol", "busy"]),
    message: z.string().max(4096),
  }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
export type Terminal = Extract<ServerFrame, { type: "terminal" }>;
const bindingKeys = [
  "gatewayId",
  "workspaceId",
  "sessionId",
  "runId",
  "attemptId",
  "epoch",
  "connectionId",
] as const;
export function sameBinding(a: TurnBinding, b: TurnBinding): boolean {
  return bindingKeys.every((key) => a[key] === b[key]);
}
export function assertRuntimeUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "ws:" && url.protocol !== "wss:")
  ) {
    throw new Error("Invalid built-in runtime URL");
  }
  if (url.protocol === "ws:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
    throw new Error(
      "Built-in runtime requires wss outside loopback; use a TLS proxy or SSH tunnel",
    );
  }
  return url;
}

/** Decode every ws text-frame representation without implicit object coercion. */
export function decodeRuntimeFrame(data: RawData): unknown {
  const bytes = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  return JSON.parse(bytes.toString("utf8"));
}
