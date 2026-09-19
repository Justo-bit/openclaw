import { isDeepStrictEqual } from "node:util";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { getAgentRunContext, getAgentRunLifecycleGeneration } from "../infra/agent-run-registry.js";
import type { SqliteWorkerNativeSettlementOwner } from "../infra/sqlite-worker-operation-settlement.js";
import { runWithGatewayDetachedWorkContinuation } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { restoreAgentSchemaInspectionError } from "../state/openclaw-agent-schema-inspection-response.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { hasAuthoritativeTaskBacking, readTaskBackingInstance } from "./task-backing-authority.js";
import { finishTaskMutation, retainTaskMutationFlowEffects } from "./task-executor-create.async.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import { clearTaskActivity, flushTaskActivity } from "./task-registry-activity.js";
import { recoverTaskAgentEventPublication } from "./task-registry-agent-event-commit.js";
import {
  captureTaskAgentEventChange,
  captureTaskAgentEventLineage,
  readTaskAgentEventCommittedTarget,
  matchesTaskAgentEventTarget,
  prepareTaskAgentEventUpdate,
  TASK_ACTIVITY_LIVENESS_WRITE_MS,
  type TaskAgentEventInput,
  type TaskAgentEventPublication,
  type TaskAgentEventReceipt,
} from "./task-registry-agent-event.operation.js";
import {
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
} from "./task-registry-delivery.js";
import { updateTask } from "./task-registry-mutation.js";
import { captureTaskPersistenceReceipt, isEquivalentTaskRecord } from "./task-registry-records.js";
import {
  runTaskRegistryWorkerMutation,
  taskFlowSyncOwner,
  taskRegistryLog,
  tasks,
} from "./task-registry-state.js";
import { getTaskRegistryStore, type TaskRegistryStore } from "./task-registry.store.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";
import { getTaskRunOwner } from "./task-run-owner.js";

type EventSource = {
  runId: string;
  lifecycleGeneration: string;
  runContext: ReturnType<typeof getAgentRunContext>;
  subagent: ReturnType<typeof subagentRuns.get>;
  subagentGeneration: number | undefined;
};
type PendingEvent = {
  input: TaskAgentEventInput;
  source: EventSource;
  context: OpenClawStateWorkerContext;
  store: TaskRegistryStore;
  flowStore: ReturnType<typeof getTaskFlowRegistryStore>;
  phase:
    | { kind: "waiting" | "worker" | "native" | "consumed" }
    | { kind: "granted"; owner: SqliteWorkerNativeSettlementOwner };
  native: ReturnType<typeof createDeferredCore<TaskAgentEventReceipt | null>>;
  claimed: Error;
  receipt?: TaskAgentEventReceipt | null;
  publication?: TaskAgentEventPublication;
  commitFacts?: unknown;
  committedTarget?: TaskAgentEventInput["expectedTask"];
};

const pendingEvents = new Set<PendingEvent>();
const pendingByTask = new Map<string, Set<PendingEvent>>();
const drains = new Set<Promise<void>>();
let draining = false;
let active: PendingEvent | undefined;

registerOpenClawStateDatabaseAsyncResource({
  async close(identity) {
    if (
      !identity ||
      [...pendingEvents].some((pending) => pending.context.admission.identity.key === identity.key)
    ) {
      await Promise.allSettled(drains);
    }
  },
});

function assertCurrent(pending: PendingEvent): void {
  const { input, source, context, store, flowStore } = pending;
  context.admission.assertCurrent();
  const runContext = getAgentRunContext(source.runId);
  if (
    getTaskRegistryStore() !== store ||
    getTaskFlowRegistryStore() !== flowStore ||
    getAgentRunLifecycleGeneration() !== source.lifecycleGeneration ||
    (runContext && runContext !== source.runContext)
  ) {
    throw new Error("Task event no longer belongs to its captured runtime owner");
  }
  if (
    input.backing?.runtime === "subagent" &&
    (subagentRuns.get(source.runId) !== source.subagent ||
      source.subagent?.generation !== source.subagentGeneration ||
      source.subagent?.childSessionKey !== input.expectedTask.childSessionKey)
  ) {
    throw new Error("Task event subagent backing was replaced");
  }
  const current = tasks.get(input.taskId);
  if (current && !matchesTaskAgentEventTarget(current, input)) {
    throw new Error("Task event selection was replaced");
  }
  if (input.change.kind === "terminal" && current && getTaskRunOwner(current)) {
    throw new Error("Task event cannot terminalize a producer-owned task");
  }
}

function forget(pending: PendingEvent): void {
  pendingEvents.delete(pending);
  const entries = pendingByTask.get(pending.input.taskId);
  entries?.delete(pending);
  if (entries?.size === 0) {
    pendingByTask.delete(pending.input.taskId);
  }
}

function advanceCommittedLineage(pending: PendingEvent, facts: unknown): void {
  const next = readTaskAgentEventCommittedTarget(facts, pending.input);
  pending.committedTarget = next;
  for (const entry of pendingByTask.get(pending.input.taskId) ?? []) {
    if (
      entry !== pending &&
      entry !== active &&
      entry.store === pending.store &&
      entry.context.admission.identity.key === pending.context.admission.identity.key &&
      sameSource(entry.source, pending.source) &&
      isDeepStrictEqual(entry.input.expectedTask, pending.input.expectedTask) &&
      isDeepStrictEqual(entry.input.backing, pending.input.backing)
    ) {
      entry.input = { ...entry.input, expectedTask: next };
    }
  }
}

function reportFailure(pending: PendingEvent, error: unknown): void {
  taskRegistryLog.warn(
    pending.receipt || pending.committedTarget
      ? "Task agent event committed before follow-up failed"
      : "Failed to persist accepted task agent event",
    {
      taskId: pending.input.taskId,
      runId: pending.source.runId,
      error,
    },
  );
}

function retainCommittedEventAfterResultFailure(pending: PendingEvent): void {
  const facts =
    pending.phase.kind === "granted" ? pending.phase.owner.settlement?.committed?.facts : undefined;
  if (!pending.receipt && facts !== undefined) {
    pending.commitFacts = facts;
    advanceCommittedLineage(pending, facts);
  }
}

function publishDelivery(receipt: TaskAgentEventPublication): void {
  if (receipt.task.deliveryStatus === "not_applicable" || receipt.task.notifyPolicy === "silent") {
    return;
  }
  if (receipt.nextEvent) {
    void maybeDeliverTaskStateChangeUpdate(receipt.task.taskId, receipt.nextEvent);
  }
  if (isTerminalTaskStatus(receipt.task.status)) {
    void maybeDeliverTaskTerminalUpdate(receipt.task.taskId);
  }
}

function prepareNativeEventConsumption(): { consume: () => void; release: () => void } | undefined {
  const store = getTaskRegistryStore();
  const pending = [...pendingEvents].filter(
    (entry) => entry.store === store && entry.phase.kind !== "consumed",
  );
  if (!pending.length) {
    return undefined;
  }
  const claimed = pending.filter(
    (entry) => entry.phase.kind !== "granted" && entry.phase.kind !== "native",
  );
  for (const entry of claimed) {
    entry.phase = { kind: "native" };
  }
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    for (const entry of claimed) {
      if (entry.phase.kind === "native") {
        entry.phase = { kind: entry === active ? "worker" : "waiting" };
      }
    }
  };
  try {
    if (pending.some((entry) => entry.phase.kind === "granted")) {
      // Join the granted transaction before a WAL read can select its predecessor.
      // Ungranted batches have already lost permission to perform the same write.
      store.settleAgentEventWrites((deadlineMs) => {
        for (const entry of pending) {
          if (entry.phase.kind !== "granted") {
            continue;
          }
          const completed = entry.phase.owner.waitForSettlement(deadlineMs);
          if (completed.committed) {
            advanceCommittedLineage(entry, completed.committed.facts);
          }
        }
      });
    }
  } catch (error) {
    release();
    throw error;
  }
  return {
    release,
    consume() {
      for (const entry of claimed) {
        try {
          assertCurrent(entry);
        } catch (error) {
          entry.phase = { kind: "consumed" };
          entry.native.reject(error);
          if (entry !== active) {
            reportFailure(entry, error);
            forget(entry);
          }
          continue;
        }
        const current = tasks.get(entry.input.taskId);
        const receipt =
          current && hasAuthoritativeTaskBacking(current)
            ? prepareTaskAgentEventUpdate(current, entry.input)
            : null;
        if (receipt && !updateTask(receipt.task.taskId, receipt.patch)) {
          throw new Error("Failed to persist accepted task event before synchronous mutation");
        }
        if (receipt) {
          advanceCommittedLineage(entry, captureTaskAgentEventLineage(receipt));
        }
        entry.phase = { kind: "consumed" };
        entry.native.resolve(receipt);
        if (entry !== active) {
          forget(entry);
        }
        if (receipt) {
          publishDelivery(receipt);
        }
      }
    },
  };
}

export const taskAgentEventMutations = {
  prepare: prepareNativeEventConsumption,
  pending: () => pendingEvents.size > 0,
};

async function persist(pending: PendingEvent): Promise<void> {
  const { input, context, store, flowStore } = pending;
  const taskId = input.taskId;
  const scope = {
    taskId,
    runId: input.expectedTask.runId,
    childSessionKey: input.expectedTask.childSessionKey,
  };
  let flowEffectsSettled = false;
  try {
    await runTaskRegistryWorkerMutation(
      {
        scope,
        admission: context.admission,
        publicationRecords: () =>
          new Map(
            pending.publication && pending.phase.kind !== "consumed"
              ? [[taskId, pending.publication.task]]
              : [],
          ),
        recoverPublication: (snapshot) => {
          if (
            pending.commitFacts === undefined ||
            pending.receipt ||
            pending.phase.kind === "consumed"
          ) {
            return undefined;
          }
          pending.publication = recoverTaskAgentEventPublication(
            pending.commitFacts,
            input,
            snapshot.tasks.get(taskId),
          );
          return pending.publication?.task;
        },
        beforeObservers: async (assertCurrentPublication) => {
          if (pending.publication && pending.phase.kind !== "consumed") {
            const current = tasks.get(taskId);
            if (
              pending.publication.becomesTerminal &&
              current &&
              isEquivalentTaskRecord(current, pending.publication.task)
            ) {
              clearTaskActivity(taskId);
            }
            await finishTaskMutation(context, store, flowStore, taskId, {
              operation: "update",
              assertCurrent: () => {
                assertCurrentPublication();
                if (getTaskRegistryStore() !== store || getTaskFlowRegistryStore() !== flowStore) {
                  throw new Error("Task event publication owners changed");
                }
              },
            });
            flowEffectsSettled = true;
          }
        },
        forcePublish: () => pending.publication?.task,
        onPublished: (task) => {
          if (
            pending.publication &&
            pending.phase.kind !== "consumed" &&
            isEquivalentTaskRecord(task, pending.publication.task)
          ) {
            publishDelivery(pending.publication);
          }
        },
      },
      async (beginRecovery) => {
        await taskFlowSyncOwner(taskId).prepare(context, store, Number.POSITIVE_INFINITY);
        if (pending.phase.kind === "consumed" || pending.phase.kind === "native") {
          return await pending.native.promise;
        }
        assertCurrent(pending);
        const current = tasks.get(taskId);
        if (!current || !matchesTaskAgentEventTarget(current, input)) {
          return null;
        }
        if (input.change.kind === "terminal") {
          flushTaskActivity(taskId);
        }
        pending.phase = { kind: "worker" };
        while (true) {
          try {
            pending.receipt = await store.runAgentEventMutationAsync(
              context,
              input,
              () => {
                if (pending.phase.kind === "native" || pending.phase.kind === "consumed") {
                  throw pending.claimed;
                }
                assertCurrent(pending);
              },
              (owner) => {
                beginRecovery();
                pending.phase = { kind: "granted", owner };
              },
            );
            pending.publication = pending.receipt ?? undefined;
            if (pending.receipt) {
              advanceCommittedLineage(pending, captureTaskAgentEventLineage(pending.receipt));
            }
            if (pending.receipt?.cleanupError) {
              throw restoreAgentSchemaInspectionError(pending.receipt.cleanupError);
            }
            return pending.receipt;
          } catch (error) {
            if (error !== pending.claimed) {
              // The store joins native retirement before rejecting. Confirmed
              // commit facts survive even when the native outcome stays unknown.
              retainCommittedEventAfterResultFailure(pending);
              throw error;
            }
            if (pending.phase.kind !== "worker") {
              return await pending.native.promise;
            }
            // Only this exact refusal, followed by joined settlement, proves that
            // the failed native claimant left this batch unconsumed and unwritten.
          }
        }
      },
      () => store.loadMutationSnapshotAsync(context, scope),
    );
  } finally {
    if (!flowEffectsSettled && pending.committedTarget && pending.phase.kind !== "consumed") {
      const current = tasks.get(taskId);
      if (
        current &&
        matchesTaskAgentEventTarget(current, { ...input, expectedTask: pending.committedTarget })
      ) {
        retainTaskMutationFlowEffects(context, store, flowStore, current, "update");
      }
    }
  }
}

function startDrain(): void {
  if (draining) {
    return;
  }
  draining = true;
  const operation = runWithGatewayDetachedWorkContinuation(async () => {
    try {
      while ((active = pendingEvents.values().next().value)) {
        const entry = active;
        try {
          await Promise.resolve();
          if (entry.phase.kind === "consumed") {
            await entry.native.promise;
          } else {
            await persist(entry);
          }
        } catch (error) {
          reportFailure(entry, error);
        } finally {
          forget(entry);
          active = undefined;
        }
      }
    } finally {
      draining = false;
    }
  }, "tasks:agent-events").catch((error: unknown) => {
    draining = false;
    for (const entry of pendingEvents) {
      reportFailure(entry, error);
      forget(entry);
    }
  });
  drains.add(operation);
  void operation.finally(() => drains.delete(operation));
}

function sameSource(left: EventSource, right: EventSource): boolean {
  return (
    left.runId === right.runId &&
    left.lifecycleGeneration === right.lifecycleGeneration &&
    left.runContext === right.runContext &&
    left.subagent === right.subagent &&
    left.subagentGeneration === right.subagentGeneration
  );
}

/** At most one active batch and four ordered pending batches per live task identity. */
export function enqueueTaskAgentEvent(task: TaskRecord, event: AgentEventPayload): boolean {
  const runId = event.runId;
  const subagent = subagentRuns.get(runId);
  const source: EventSource = {
    runId,
    lifecycleGeneration: event.lifecycleGeneration ?? getAgentRunLifecycleGeneration(),
    runContext: getAgentRunContext(runId),
    subagent,
    subagentGeneration: subagent?.generation,
  };
  const entries = pendingByTask.get(task.taskId);
  for (const entry of entries ?? []) {
    if (
      entry !== active &&
      (!matchesTaskAgentEventTarget(task, entry.input) || !sameSource(source, entry.source))
    ) {
      reportFailure(entry, new Error("Queued task event identity was replaced before admission"));
      forget(entry);
    }
  }
  const matching = [...(pendingByTask.get(task.taskId) ?? [])].filter(
    (entry) => matchesTaskAgentEventTarget(task, entry.input) && sameSource(source, entry.source),
  );
  if (matching.some((entry) => entry.input.change.kind === "terminal")) {
    return false;
  }
  const lastAcceptedAt = matching.reduce(
    (at, entry) => Math.max(at, entry.input.change.at),
    task.lastEventAt ?? task.startedAt ?? task.createdAt,
  );
  const needsPersistence =
    event.stream === "lifecycle" ||
    event.stream === "error" ||
    (event.stream === "tool" && event.data.phase === "start") ||
    event.ts - lastAcceptedAt >= TASK_ACTIVITY_LIVENESS_WRITE_MS;
  if (!needsPersistence) {
    return true;
  }
  const backing = readTaskBackingInstance(task.detail);
  const change = captureTaskAgentEventChange(
    task,
    event,
    !getTaskRunOwner(task) && !(task.runtime === "subagent" && backing?.runtime === "subagent"),
  );
  if (!change) {
    return true;
  }
  if (
    change.kind === "start" &&
    (task.status !== "queued" || matching.some((entry) => entry.input.change.kind === "start"))
  ) {
    change.kind = "progress";
  }
  const previous = matching.at(-1);
  if (
    change.kind === "progress" &&
    previous?.phase.kind === "waiting" &&
    previous !== active &&
    previous.input.change.kind === "progress"
  ) {
    previous.input.change = {
      ...change,
      toolStarts: previous.input.change.toolStarts + change.toolStarts,
      refreshStartedAt: previous.input.change.refreshStartedAt || change.refreshStartedAt,
      refreshError: previous.input.change.refreshError || change.refreshError,
      patch: { ...previous.input.change.patch, ...change.patch },
    };
    return true;
  }
  const context = captureOpenClawStateWorkerContext();
  const entry: PendingEvent = {
    input: {
      taskId: task.taskId,
      expectedTask: captureTaskPersistenceReceipt(task),
      backing,
      change,
    },
    source,
    context,
    store: getTaskRegistryStore(),
    flowStore: getTaskFlowRegistryStore(),
    phase: { kind: "waiting" },
    native: createDeferredCore(),
    claimed: new Error("Task event was claimed by synchronous registry mutation"),
  };
  void entry.native.promise.catch(() => undefined);
  pendingEvents.add(entry);
  const taskEvents = pendingByTask.get(task.taskId) ?? new Set<PendingEvent>();
  taskEvents.add(entry);
  pendingByTask.set(task.taskId, taskEvents);
  startDrain();
  return true;
}
