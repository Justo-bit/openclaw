import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { buildWaitingStatusPayload } from "./waiting-status.js";

describe("buildWaitingStatusPayload", () => {
  const baseParams = {
    yielded: true,
    yieldAcknowledgment: " Research started; results will follow. ",
    isInteractive: true,
    isSubagentSession: false,
    hasExplicitSilentReply: false,
    hasVisibleMessageDelivery: false,
  } as const;

  it("prefers an explicit acknowledgment over prepared task progress", () => {
    const payload = buildWaitingStatusPayload({
      ...baseParams,
      preparedAcknowledgment: "Index worker: checking database boundaries.",
    });

    expect(payload?.text).toBe(baseParams.yieldAcknowledgment.trim());
    expect(getReplyPayloadMetadata(payload ?? {})?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it("uses prepared task progress for an implicit continuation and preserves its receipt marker", () => {
    const preparedAcknowledgment = "Index worker: checking database boundaries.";
    const payload = buildWaitingStatusPayload({
      ...baseParams,
      yielded: false,
      continuationPending: true,
      yieldAcknowledgment: " ",
      preparedAcknowledgment,
    });

    expect(payload?.text).toBe(preparedAcknowledgment);
    expect(getReplyPayloadMetadata(payload ?? {})).toMatchObject({
      continuationStatus: true,
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it.each([
    { label: "non-yielded turn", overrides: { yielded: false } },
    { label: "internal turn", overrides: { isInteractive: false } },
    { label: "heartbeat", overrides: { isHeartbeat: true } },
    { label: "silent turn", overrides: { silentExpected: true } },
    { label: "subagent session", overrides: { isSubagentSession: true } },
    { label: "explicit silent reply", overrides: { hasExplicitSilentReply: true } },
    { label: "visible message delivery", overrides: { hasVisibleMessageDelivery: true } },
  ])("suppresses the status for a $label", ({ overrides }) => {
    expect(buildWaitingStatusPayload({ ...baseParams, ...overrides })).toBeUndefined();
    expect(
      buildWaitingStatusPayload({
        ...baseParams,
        yieldAcknowledgment: undefined,
        preparedAcknowledgment: "Index worker: checking database boundaries.",
        ...overrides,
      }),
    ).toBeUndefined();
  });
});
