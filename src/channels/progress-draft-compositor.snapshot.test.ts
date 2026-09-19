import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeConversationProgressSnapshot } from "../config/sessions/conversation-progress-snapshot.js";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";
import type { ChannelProgressDraftCompositorParams } from "./progress-draft-compositor.types.js";

function createProgress(overrides: Partial<ChannelProgressDraftCompositorParams> = {}) {
  return createChannelProgressDraftCompositor({
    active: true,
    mode: "progress",
    seed: "snapshot",
    preparedItems: true,
    entry: {
      streaming: {
        mode: "progress",
        progress: { label: false, commentary: true, toolProgress: true, maxLines: 8 },
      },
    },
    update: () => true,
    ...overrides,
  });
}

describe("progress draft snapshot continuation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("redacts public progress before rendering and durable snapshot capture", async () => {
    const secret = `sk-test-${"a".repeat(48)}`;
    const update = vi.fn<ChannelProgressDraftCompositorParams["update"]>(() => true);
    const progress = createProgress({
      update,
      entry: {
        streaming: {
          mode: "progress",
          progress: { label: `Account ${secret}`, commentary: true, toolProgress: true },
        },
      },
    });
    try {
      await progress.start();
      await progress.pushPlanProgress(
        [{ step: `Check account ${secret}`, status: "in_progress" }],
        { explanation: `Validate account ${secret}` },
      );
      await progress.pushNarrationProgress(`Inspect account ${secret}`);
      await progress.pushToolProgress({
        id: "public-tool",
        kind: "tool",
        text: `Read account ${secret}`,
        label: `Account tool ${secret}`,
        detail: `Account value ${secret}`,
      });
      await progress.pushCommentaryProgress(`Checking account ${secret}`);
      const snapshot = progress.getSnapshot();
      expect(JSON.stringify(update.mock.calls)).not.toContain(secret);
      expect(serializeConversationProgressSnapshot(snapshot)).not.toContain(secret);
      expect(snapshot.plan?.[0]?.step).toContain("Check account");
      expect(update.mock.calls[0]?.[0]).toContain("Account");
    } finally {
      progress.cancel();
    }
  });

  it("keeps the parent card through keyed child updates without inheriting delivery", async () => {
    vi.useFakeTimers();
    const parentUpdate = vi.fn(() => true);
    const parent = createProgress({ update: parentUpdate });
    await parent.pushPlanProgress(
      [
        { step: "Inspect", status: "completed" },
        { step: "Repair", status: "in_progress" },
      ],
      { explanation: "Checking *literal* input", explanationFormat: "plain" },
    );
    await parent.pushCommentaryProgress("I will keep the existing card", { itemId: "parent" });
    await parent.pushItemEvent({ itemId: "child", kind: "tool", name: "read", status: "running" });
    const initialSnapshot = structuredClone(parent.getSnapshot());
    parent.cancel();
    parentUpdate.mockClear();

    const update = vi.fn<ChannelProgressDraftCompositorParams["update"]>();
    update.mockReturnValueOnce(false).mockReturnValue(true);
    const progress = createProgress({ initialSnapshot, update });
    try {
      expect(update).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(progress.hasStarted).toBe(false);
      expect(progress.isVisible).toBe(false);
      expect(await progress.noteActivity({ startImmediately: true })).toBe(false);
      expect(progress.isVisible).toBe(false);

      progress.beginAssistantMessage();
      expect(
        await progress.pushItemEvent({
          itemId: "child",
          kind: "tool",
          name: "read",
          status: "completed",
        }),
      ).toBe(true);
      expect(progress.isVisible).toBe(true);
      const text = update.mock.lastCall?.[0] ?? "";
      expect(text).toContain("I will keep the existing card");
      expect(text).toContain("Inspect");
      expect(text).toContain("Repair");
      expect(text).toContain("Checking \\*literal\\* input");
      expect(progress.getSnapshot()).toMatchObject({
        plan: initialSnapshot.plan,
        planExplanation: initialSnapshot.planExplanation,
        planExplanationFormat: "plain",
        statusHeadlineFormat: "plain",
      });
      expect(
        progress
          .getSnapshot()
          .lines.filter((line) => typeof line === "object" && line.id === "child"),
      ).toEqual([expect.objectContaining({ status: "completed" })]);
      expect(parentUpdate).not.toHaveBeenCalled();
    } finally {
      progress.cancel();
    }
  });

  it("retains detached headline and label data until an explicit status replacement", async () => {
    const initialSnapshot = {
      label: "Parent label",
      lines: [
        { id: "commentary:parent", kind: "item" as const, text: "Parent note", label: "Note" },
      ],
      plan: [{ step: "Parent step", status: "in_progress" as const }],
      planExplanation: "Underlying plan",
      statusHeadline: "Transferred *headline*",
      statusHeadlineFormat: "plain" as const,
      preparedBlocks: [{ text: "Old transport markup", format: "markdown" as const }],
    };
    const update = vi.fn<ChannelProgressDraftCompositorParams["update"]>(() => true);
    const progress = createProgress({ initialSnapshot, update });
    initialSnapshot.lines[0]!.text = "Mutated note";
    initialSnapshot.plan[0]!.step = "Mutated step";
    try {
      await progress.noteActivity({ startImmediately: true });
      expect(update.mock.lastCall?.[0]).toContain("Parent label");
      expect(update.mock.lastCall?.[0]).toContain("Parent note");
      expect(update.mock.lastCall?.[0]).toContain("Parent step");
      expect(update.mock.lastCall?.[1].snapshot.preparedBlocks).toContainEqual({
        text: "Transferred *headline*",
        format: "plain",
      });
      expect(update.mock.lastCall?.[0]).not.toContain("Old transport markup");
      expect(progress.getSnapshot().planExplanation).toBe("Underlying plan");

      await progress.pushNarrationProgress("Child status");
      expect(update.mock.lastCall?.[0]).toContain("Child status");
      expect(update.mock.lastCall?.[0]).not.toContain("Transferred");
      expect(progress.getSnapshot().statusHeadlineFormat).toBeUndefined();
      expect(progress.getSnapshot().plan).toEqual([{ step: "Parent step", status: "in_progress" }]);
    } finally {
      progress.cancel();
    }
  });

  it("applies privacy, quiet failures, approval priority and bounds to transferred lines", async () => {
    const parent = createProgress();
    await parent.pushPlanProgress([{ step: "Parent checklist", status: "in_progress" }]);
    await parent.pushItemEvent({
      itemId: "private",
      kind: "tool",
      name: "read",
      title: "Sensitive row",
    });
    await parent.pushApprovalEvent({
      phase: "requested",
      approvalId: "approval",
      title: "Allow repair",
    });
    const initialSnapshot = parent.getSnapshot();
    parent.cancel();
    const update = vi.fn<ChannelProgressDraftCompositorParams["update"]>(() => true);
    const progress = createProgress({
      initialSnapshot,
      update,
      entry: {
        streaming: {
          mode: "progress",
          progress: { label: false, commentary: true, toolProgress: false, maxLines: 2 },
        },
      },
    });
    try {
      await progress.noteActivity({ startImmediately: true });
      await progress.pushItemEvent({ itemId: "private", hideFromChannelProgress: true });
      expect(progress.getSnapshot().lines).not.toContainEqual(
        expect.objectContaining({ id: "private" }),
      );
      await progress.pushItemEvent({
        itemId: "failed",
        kind: "tool",
        name: "exec",
        status: "failed",
      });
      expect(progress.getSnapshot().lines).not.toContainEqual(
        expect.objectContaining({ id: "failed" }),
      );
      await progress.pushCommentaryProgress("Child note", { itemId: "child" });
      const text = update.mock.lastCall?.[0] ?? "";
      expect(text).toContain("Allow repair");
      expect(text).toContain("Parent checklist");
      expect(text).not.toContain("Sensitive row");
      expect(text).not.toContain("failed");
      expect(text.split("\n").filter(Boolean)).toHaveLength(2);
      await progress.pushApprovalEvent({ phase: "resolved", approvalId: "approval" });
      expect(update.mock.lastCall?.[0]).not.toContain("Allow repair");
      expect(update.mock.lastCall?.[0]).toContain("Child note");
    } finally {
      progress.cancel();
    }
  });

  it("retains known mutation totals without inventing cross-owner file uniqueness", async () => {
    const progress = createProgress({
      initialSnapshot: { lines: [], diffStat: { files: 1, added: 2, removed: 1 } },
    });
    try {
      await progress.pushToolEvent({
        toolCallId: "child-write",
        name: "write",
        phase: "start",
        args: { path: "possibly-the-parent-file.ts", content: "one\ntwo\nthree" },
      });
      await progress.pushItemEvent({
        toolCallId: "child-write",
        phase: "end",
        status: "completed",
      });
      expect(progress.getSnapshot().diffStat).toEqual({ files: 1, added: 2, removed: 1 });
      progress.resetActivity();
      expect(progress.getSnapshot().diffStat).toBeUndefined();
      await progress.pushToolEvent({
        toolCallId: "next-write",
        name: "write",
        phase: "start",
        args: { path: "new-file.ts", content: "one\ntwo\nthree" },
      });
      await progress.pushItemEvent({ toolCallId: "next-write", phase: "end", status: "completed" });
      expect(progress.getSnapshot().diffStat).toEqual({ files: 1, added: 3, removed: 0 });
    } finally {
      progress.cancel();
    }
  });
});
