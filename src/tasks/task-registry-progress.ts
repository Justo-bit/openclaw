import type { AgentActivityItem } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  getLatestSubagentRunByChildSessionKey,
  getLatestLiveSubagentRunByChildSessionKey,
  isSubagentRunLive,
} from "../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { getAgentRunLifecycleGeneration } from "../infra/agent-run-registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  getGatewayRestartDrainSignal,
  isGatewayRestartDraining,
  runWithGatewayDetachedWorkContinuation,
} from "../process/gateway-work-admission.js";
import type { SessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import { hasAuthoritativeTaskBacking, readTaskBackingInstance } from "./task-backing-authority.js";
import { canDeliverToRequesterOrigin, resolveTaskDeliveryOwner } from "./task-registry-delivery.js";
import {
  getTasksByRunId,
  tasks,
  taskProgressBatches,
  taskRegistryLog,
  withTaskRegistryMutation,
} from "./task-registry-state.js";
import type {
  TaskProgressBatch,
  TaskProgressMember,
  TaskProgressPlan,
} from "./task-registry.process-state.js";
import type { TaskRegistryObserverEvent } from "./task-registry.store.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";
import { formatTaskStatusTitleText } from "./task-status.js";

const YIELDED_PROGRESS_COALESCE_MS = 15_000;
const MAX_PROGRESS_BATCHES = 128;
export const MAX_PROGRESS_BATCH_MEMBERS = 32;
const MAX_PENDING_PROGRESS_ITEMS = 128;
const loadProgressPresentation = createLazyPromise(() => import("./task-progress-presentation.js"));
const loadProgressRuntime = createLazyPromise(() => import("./task-registry-progress-runtime.js"));

function resolveYieldedTaskProgress(task: TaskRecord, runId: string) {
  if (task.runtime !== "subagent" || task.notifyPolicy === "silent") {
    return undefined;
  }
  const backing = readTaskBackingInstance(task.detail);
  const entry = subagentRuns.get(runId);
  const wake = entry?.requesterSettleWake;
  if (
    backing?.runtime !== "subagent" ||
    !entry ||
    entry.generation !== backing.generation ||
    !entry.completionRequesterSessionId ||
    (entry.taskRunId ?? entry.runId) !== task.runId ||
    entry.childSessionKey !== task.childSessionKey ||
    entry.requesterSessionKey !== task.ownerKey ||
    (entry.requesterAgentId !== undefined && entry.requesterAgentId !== task.requesterAgentId) ||
    entry.killIntent ||
    entry.killReconciliation ||
    entry.execution.suppressSessionEffects ||
    entry.suppressAnnounceReason ||
    entry.requesterTurnRunId ||
    entry.collect === true ||
    wake?.requesterYieldBatch !== true ||
    (wake.status !== "pending" && wake.status !== "dispatching") ||
    !wake.progressOperationId ||
    wake.rearmGeneration === undefined ||
    !wake.batchRunIds?.includes(runId) ||
    !hasAuthoritativeTaskBacking(task)
  ) {
    return undefined;
  }
  const owner = resolveTaskDeliveryOwner(task);
  if (!owner.sessionKey || !owner.agentId || !canDeliverToRequesterOrigin(owner.requesterOrigin)) {
    return undefined;
  }
  const key = JSON.stringify([
    owner.sessionKey,
    owner.agentId,
    owner.requesterOrigin,
    wake.progressOperationId,
  ]);
  return {
    task,
    entry,
    owner,
    key,
    generation: backing.generation,
    operationId: wake.progressOperationId,
    requesterSessionId: entry.completionRequesterSessionId,
  };
}

/** Detached presentation consumes prepared public activity, never raw child prose or results. */
export function scheduleYieldedSubagentTaskProgress(
  task: TaskRecord,
  event: AgentEventPayload,
  prepared?: AgentActivityItem,
) {
  if (
    event.stream !== "item" &&
    event.stream !== "tool" &&
    event.stream !== "approval" &&
    event.stream !== "execution"
  ) {
    return;
  }
  enqueueYieldedTaskProgress(task, event.runId, prepared);
}

/** The handoff itself may be the last event before a child's long-running tool returns. */
export function scheduleYieldedSubagentRunProgress(entry: SubagentRunRecord) {
  for (const task of getTasksByRunId(entry.taskRunId ?? entry.runId)) {
    enqueueYieldedTaskProgress(task, entry.runId);
  }
}

/** Read-only preparation; the normal reply dispatcher still owns acknowledgement delivery. */
export async function prepareTaskProgressAcknowledgment(params: {
  requesterSessionKey?: string;
  acceptedSessionSpawns: readonly { runId: string; childSessionKey: string }[];
}): Promise<string | undefined> {
  try {
    const requester = params.requesterSessionKey?.trim();
    if (!requester) {
      return undefined;
    }
    const rows = params.acceptedSessionSpawns
      .slice(0, MAX_PROGRESS_BATCH_MEMBERS)
      .flatMap((spawn) => {
        const entry = subagentRuns.get(spawn.runId);
        if (
          !entry ||
          entry.childSessionKey !== spawn.childSessionKey ||
          entry.requesterSessionKey !== requester ||
          entry.killIntent ||
          entry.execution.suppressSessionEffects ||
          entry.suppressAnnounceReason ||
          entry.collect
        ) {
          return [];
        }
        const task = getTasksByRunId(entry.taskRunId ?? entry.runId).find(
          (candidate) =>
            candidate.ownerKey === requester &&
            candidate.childSessionKey === entry.childSessionKey &&
            candidate.notifyPolicy !== "silent" &&
            readTaskBackingInstance(candidate.detail)?.generation === entry.generation &&
            hasAuthoritativeTaskBacking(candidate),
        );
        return task ? [{ task, entry }] : [];
      });
    const owner = rows[0] ? resolveTaskDeliveryOwner(rows[0].task) : undefined;
    if (!owner?.requesterOrigin || !rows.length) {
      return undefined;
    }
    const { prepareProgressContent } = await loadProgressPresentation();
    return (
      (await prepareProgressContent(`ack:${requester}`, owner.requesterOrigin, rows))?.content ||
      undefined
    );
  } catch (error) {
    taskRegistryLog.debug("Delegated activity preparation failed; retaining the waiting notice", {
      error,
    });
    return undefined;
  }
}

function enqueueYieldedTaskProgress(task: TaskRecord, runId: string, prepared?: AgentActivityItem) {
  const progress = resolveYieldedTaskProgress(task, runId);
  if (!progress) {
    return;
  }
  let batch = taskProgressBatches.get(progress.key);
  if (!batch) {
    if (taskProgressBatches.size >= MAX_PROGRESS_BATCHES) {
      taskRegistryLog.warn("Background progress queue is full; activity remains in Tasks");
      return;
    }
    batch = {
      lifecycleGeneration: getAgentRunLifecycleGeneration(),
      requesterSessionKey: progress.entry.requesterSessionKey,
      requesterAgentId: progress.owner.agentId,
      requesterSessionId: progress.requesterSessionId,
      operationId: progress.operationId,
      origin: { ...progress.owner.requesterOrigin },
      abortController: new AbortController(),
      members: new Map(),
      pendingItems: new Map(),
      revision: 0,
    };
    taskProgressBatches.set(progress.key, batch);
  }
  if (!batch.members.has(task.taskId) && batch.members.size >= MAX_PROGRESS_BATCH_MEMBERS) {
    for (const [taskId] of batch.members) {
      const previous = tasks.get(taskId);
      if (!previous || isTerminalTaskStatus(previous.status)) {
        batch.members.delete(taskId);
        if (batch.members.size < MAX_PROGRESS_BATCH_MEMBERS) {
          break;
        }
      }
    }
  }
  if (!batch.members.has(task.taskId) && batch.members.size >= MAX_PROGRESS_BATCH_MEMBERS) {
    return;
  }
  batch.members.set(task.taskId, {
    runId,
    taskRunId: progress.entry.taskRunId ?? progress.entry.runId,
    generation: progress.generation,
    childSessionKey: progress.entry.childSessionKey,
    progressOrigin: progress.entry.progressOrigin,
  });
  if (prepared) {
    const itemKey = JSON.stringify([task.taskId, progress.generation, prepared.itemId]);
    batch.pendingItems.delete(itemKey);
    batch.pendingItems.set(itemKey, {
      item: prepared,
      source: {
        taskId: task.taskId,
        runId,
        generation: progress.generation,
        label: formatTaskStatusTitleText(task.label, "Subagent"),
      },
    });
    trimPendingItems(batch);
  }
  batch.revision += 1;
  scheduleProgressBatch(progress.key, batch);
}

function trimPendingItems(batch: TaskProgressBatch): void {
  while (batch.pendingItems.size > MAX_PENDING_PROGRESS_ITEMS) {
    const oldest = batch.pendingItems.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    batch.pendingItems.delete(oldest);
  }
}

export function getTaskProgressBatchesForRuns(entries: readonly SubagentRunRecord[]) {
  const generations = new Map(entries.map((entry) => [entry.runId, entry.generation]));
  for (const entry of entries) {
    scheduleYieldedSubagentRunProgress(entry);
  }
  return [...taskProgressBatches].flatMap(([key, batch]) =>
    [...batch.members.values()].some(
      (member) => generations.get(member.runId) === member.generation,
    ) && prepareProgressBatch(key, batch)
      ? [{ key, batch }]
      : [],
  );
}

export function recordRequesterTaskProgress(
  key: string,
  batch: TaskProgressBatch,
  update: { kind: "item"; item: AgentActivityItem } | { kind: "plan"; plan: TaskProgressPlan },
): void {
  const requester = batch.requesterContinuation;
  if (!requester || !requester.isCurrent() || !prepareProgressBatch(key, batch)) {
    return;
  }
  if (update.kind === "plan") {
    batch.pendingPlan = update.plan;
  } else {
    const itemId = `requester:${requester.runId}:${update.item.itemId}`;
    batch.pendingItems.delete(itemId);
    batch.pendingItems.set(itemId, {
      item: {
        ...update.item,
        itemId,
        ...(update.item.toolCallId
          ? { toolCallId: `requester:${requester.runId}:${update.item.toolCallId}` }
          : {}),
      },
    });
    trimPendingItems(batch);
  }
  batch.revision += 1;
  scheduleProgressBatch(key, batch);
}

export async function flushTaskProgressBatch(key: string, batch: TaskProgressBatch): Promise<void> {
  clearTimeout(batch.timer);
  batch.timer = undefined;
  await batch.publication;
  if (prepareProgressBatch(key, batch)) {
    clearTimeout(batch.timer);
    batch.timer = undefined;
    await publishProgressBatch(key, batch);
  }
}

function scheduleProgressBatch(key: string, batch: TaskProgressBatch, immediate = false) {
  if (batch.publication || (batch.timer && !immediate)) {
    return;
  }
  clearTimeout(batch.timer);
  batch.timer = setTimeout(
    () => {
      batch.timer = undefined;
      void publishProgressBatch(key, batch);
    },
    immediate ? 0 : YIELDED_PROGRESS_COALESCE_MS,
  );
  batch.timer.unref?.();
}

function retireProgressBatch(key: string, batch: TaskProgressBatch) {
  if (taskProgressBatches.get(key) !== batch) {
    return;
  }
  taskProgressBatches.delete(key);
  clearTimeout(batch.timer);
  batch.abortController.abort();
}

export function reconcileTaskProgressBatches(event?: TaskRegistryObserverEvent): void {
  const taskId =
    event?.kind === "upserted"
      ? event.task.taskId
      : event?.kind === "deleted"
        ? event.taskId
        : undefined;
  for (const [key, batch] of taskProgressBatches) {
    if (taskId && !batch.members.has(taskId)) {
      continue;
    }
    const current = prepareProgressBatch(key, batch);
    if (!current) {
      retireProgressBatch(key, batch);
    } else if (event || current.complete) {
      if (event) {
        batch.revision += 1;
      }
      scheduleProgressBatch(
        key,
        batch,
        current.complete || (event?.kind === "upserted" && isTerminalTaskStatus(event.task.status)),
      );
    }
  }
  if (event?.kind === "upserted") {
    const task = tasks.get(event.task.taskId);
    if (task?.runtime === "subagent" && task.childSessionKey) {
      const entry = getLatestSubagentRunByChildSessionKey(task.childSessionKey);
      if (entry) {
        enqueueYieldedTaskProgress(task, entry.runId);
      }
    }
  } else if (event?.kind === "restored") {
    for (const entry of subagentRuns.values()) {
      if (entry.requesterSettleWake?.requesterYieldBatch) {
        scheduleYieldedSubagentRunProgress(entry);
      }
    }
  }
}

export function retireTaskProgressForSession(mutation: SessionIdentityMutation): void {
  for (const [key, batch] of taskProgressBatches) {
    if (batch.requesterAgentId && batch.requesterAgentId !== mutation.agentId) {
      continue;
    }
    if (
      mutation.previous.sessionKeys.includes(batch.requesterSessionKey) ||
      (mutation.kind !== "delete" &&
        mutation.current.sessionKeys.includes(batch.requesterSessionKey))
    ) {
      retireProgressBatch(key, batch);
    }
  }
}

function prepareProgressBatch(key: string, batch: TaskProgressBatch) {
  if (
    taskProgressBatches.get(key) !== batch ||
    batch.abortController.signal.aborted ||
    isGatewayRestartDraining() ||
    batch.lifecycleGeneration !== getAgentRunLifecycleGeneration()
  ) {
    return undefined;
  }
  const rows: Array<{ task: TaskRecord; entry: TaskProgressMember }> = [];
  let awaitingTerminal = false;
  let hasPendingWake = false;
  for (const [taskId, member] of batch.members) {
    const task = tasks.get(taskId);
    const backing = task ? readTaskBackingInstance(task.detail) : undefined;
    if (
      !task ||
      task.runtime !== "subagent" ||
      task.notifyPolicy === "silent" ||
      task.runId !== member.taskRunId ||
      task.ownerKey !== batch.requesterSessionKey ||
      backing?.runtime !== "subagent" ||
      backing.generation !== member.generation ||
      task.childSessionKey !== member.childSessionKey
    ) {
      continue;
    }
    const owner = resolveTaskDeliveryOwner(task);
    if (
      owner.agentId !== batch.requesterAgentId ||
      (owner.requesterOrigin &&
        JSON.stringify(owner.requesterOrigin) !== JSON.stringify(batch.origin))
    ) {
      continue;
    }
    const latest = getLatestLiveSubagentRunByChildSessionKey(member.childSessionKey);
    if (
      latest &&
      (latest.taskRunId ?? latest.runId) === task.runId &&
      (latest.runId !== member.runId || latest.generation !== member.generation)
    ) {
      continue;
    }
    const entry = subagentRuns.get(member.runId);
    if (
      entry &&
      (entry.generation !== member.generation ||
        entry.requesterSessionKey !== batch.requesterSessionKey ||
        entry.completionRequesterSessionId !== batch.requesterSessionId ||
        entry.collect ||
        (entry.requesterSettleWake?.progressOperationId &&
          entry.requesterSettleWake.progressOperationId !== batch.operationId))
    ) {
      continue;
    }
    const active = resolveYieldedTaskProgress(task, member.runId);
    if (active?.key === key) {
      hasPendingWake = true;
      rows.push({ task, entry: member });
    } else if (isTerminalTaskStatus(task.status)) {
      const wake = entry?.requesterSettleWake;
      hasPendingWake ||=
        wake?.progressOperationId === batch.operationId &&
        wake.batchRunIds?.includes(member.runId) === true;
      rows.push({ task, entry: member });
    } else if (entry?.killIntent || entry?.killReconciliation) {
      awaitingTerminal = true;
    }
  }
  if (rows.length === 0 && !awaitingTerminal) {
    return undefined;
  }
  rows.sort(
    (left, right) =>
      left.task.createdAt - right.task.createdAt ||
      left.task.taskId.localeCompare(right.task.taskId),
  );
  return {
    owner: {
      sessionKey: batch.requesterSessionKey,
      agentId: batch.requesterAgentId,
      requesterOrigin: batch.origin,
    },
    origin: batch.origin,
    sessionKey: batch.requesterSessionKey,
    rows,
    complete:
      !awaitingTerminal &&
      !hasPendingWake &&
      !batch.requesterContinuation?.isCurrent() &&
      rows.every(({ task }) => isTerminalTaskStatus(task.status)),
    membersKey: JSON.stringify(
      rows.map(({ task, entry }) => [task.taskId, task.status, entry.runId, entry.generation]),
    ),
  };
}

async function ensureProgressTyping(key: string, batch: TaskProgressBatch): Promise<void> {
  if (batch.typingStarted || batch.abortController.signal.aborted) {
    return;
  }
  const current = prepareProgressBatch(key, batch);
  const requesterSessionId = batch.requesterSessionId;
  const operationId = batch.operationId;
  if (
    !current ||
    !operationId ||
    !requesterSessionId ||
    !current.owner.agentId ||
    !current.origin.channel ||
    !getChannelPlugin(current.origin.channel)?.heartbeat?.sendTypingGuarded
  ) {
    return;
  }
  try {
    const { startTaskProgressTyping } = await loadProgressRuntime();
    if (!prepareProgressBatch(key, batch)) {
      return;
    }
    batch.typingStarted = startTaskProgressTyping({
      operationId,
      requesterSessionId,
      agentId: current.owner.agentId,
      sessionKey: current.sessionKey,
      origin: current.origin,
      signal: AbortSignal.any([batch.abortController.signal, getGatewayRestartDrainSignal()]),
      assertCurrent: () => {
        if (!prepareProgressBatch(key, batch)) {
          throw new Error("Task progress typing owner retired");
        }
      },
      isExecutionActive: () => {
        if (batch.requesterContinuation?.isCurrent()) {
          return true;
        }
        for (const member of batch.members.values()) {
          const entry = subagentRuns.get(member.runId);
          if (entry?.generation === member.generation && isSubagentRunLive(entry)) {
            return true;
          }
        }
        return false;
      },
      onStopped: () => {
        batch.typingStarted = false;
      },
      onError: (error) => {
        taskRegistryLog.debug("Background typing stopped", { error });
      },
    });
  } catch (error) {
    taskRegistryLog.debug("Background typing was unavailable", { error });
  }
}

function publishProgressBatch(key: string, batch: TaskProgressBatch): Promise<void> {
  if (batch.publication) {
    return batch.publication;
  }
  const revision = batch.revision;
  const publication = runProgressPublication(key, batch).finally(() => {
    if (batch.publication === publication) {
      batch.publication = undefined;
    }
    if (taskProgressBatches.get(key) !== batch) {
      return;
    }
    try {
      const current = prepareProgressBatch(key, batch);
      if (!current || (current.complete && batch.revision === revision)) {
        retireProgressBatch(key, batch);
      } else if (batch.revision !== revision) {
        scheduleProgressBatch(key, batch);
      }
    } catch (error) {
      retireProgressBatch(key, batch);
      taskRegistryLog.debug("Progress owner could not settle", {
        error: formatErrorMessage(error),
      });
    }
  });
  batch.publication = publication;
  return publication;
}

async function runProgressPublication(key: string, batch: TaskProgressBatch): Promise<void> {
  try {
    if (getGlobalHookRunner()?.hasHooks("reply_payload_sending")) {
      return;
    }
    await runWithGatewayDetachedWorkContinuation(async () => {
      const fresh = withTaskRegistryMutation(
        () => prepareProgressBatch(key, batch),
        () => undefined,
      );
      if (!fresh || fresh.rows.length === 0 || !fresh.owner.agentId) {
        return null;
      }
      const assertCurrent = () => {
        const current = prepareProgressBatch(key, batch);
        if (!current || current.membersKey !== fresh.membersKey) {
          throw new Error("Background progress was superseded before delivery");
        }
      };
      const { readTaskProgressSnapshot, publishTaskProgressMessage } = await loadProgressRuntime();
      const identity = {
        operationId: batch.operationId,
        requesterSessionId: batch.requesterSessionId,
        sessionKey: fresh.sessionKey,
        agentId: fresh.owner.agentId,
      };
      assertCurrent();
      const initialSnapshot = readTaskProgressSnapshot(identity);
      if (!initialSnapshot) {
        return null;
      }
      const capturedItems = [...batch.pendingItems].filter(([, update]) => {
        if (!update.source) {
          return true;
        }
        const task = tasks.get(update.source.taskId);
        const backing = task ? readTaskBackingInstance(task.detail) : undefined;
        return (
          task?.ownerKey === batch.requesterSessionKey &&
          task.notifyPolicy !== "silent" &&
          backing?.runtime === "subagent" &&
          backing.generation === update.source.generation
        );
      });
      const capturedPlan = batch.pendingPlan;
      const { prepareProgressContent } = await loadProgressPresentation();
      const presentation = await prepareProgressContent(
        key,
        fresh.origin,
        fresh.rows,
        initialSnapshot,
        { items: capturedItems.map(([, update]) => update), plan: capturedPlan },
      );
      if (!presentation?.content) {
        return null;
      }
      assertCurrent();
      const origin = fresh.rows[0]?.entry.progressOrigin;
      const publication = await publishTaskProgressMessage({
        ...identity,
        origin: fresh.origin,
        sourceMessageId: origin?.messageId,
        sourceChannelId: origin?.channelId,
        content: presentation.content,
        previousContent: batch.lastPublishedContent,
        snapshot: presentation.snapshot,
        signal: AbortSignal.any([batch.abortController.signal, getGatewayRestartDrainSignal()]),
        assertCurrent,
      });
      if (publication === "sent" || publication === "unchanged") {
        batch.lastPublishedContent = presentation.content;
        for (const [itemId, update] of capturedItems) {
          if (batch.pendingItems.get(itemId) === update) {
            batch.pendingItems.delete(itemId);
          }
        }
        if (batch.pendingPlan === capturedPlan) {
          batch.pendingPlan = undefined;
        }
        await ensureProgressTyping(key, batch);
      }
      return null;
    }, "tasks:progress");
  } catch (error) {
    taskRegistryLog.debug(
      "Background progress update could not finish; task completion is unaffected",
      {
        error: formatErrorMessage(error),
      },
    );
  }
}
