import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-identity-token.js";
import { createTestApprovalManager } from "../../gateway/exec-approval-manager.test-support.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../gateway/methods/registry.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { cancelAgentRuntimeBoundApprovals } from "../../gateway/server-methods/approval-run-cancellation.js";
import { createPluginApprovalHandlers } from "../../gateway/server-methods/plugin-approval.js";
import {
  registerAgentRunDelegatedAuthorityClosedHandler,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore as createDeferred } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  attemptFor,
  registerNative,
  useNativeProcessFixture,
} from "./acp-native-process.test-support.js";
import { runAgentHarnessAttempt } from "./selection.js";

useNativeProcessFixture();

it.for(["allow", "deny", "cancel"] as const)(
  "fences real native effects while the Gateway approval waits: %s",
  { timeout: 60000 },
  async (kind, test) => {
    await withOpenClawTestState({ label: "acp-native-approval-effect" }, async (state) => {
      const config: OpenClawConfig = {
        session: { store: path.join(state.sessionsDir(), "sessions.json") },
      };
      const manager = createTestApprovalManager<PluginApprovalRequestPayload>(test, {
        approvalKind: "plugin",
        validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
      });
      const gatewayWork = new AsyncWorkScope();
      const handlers = createPluginApprovalHandlers(manager);
      const methods = createGatewayMethodRegistry(createCoreGatewayMethodDescriptors(handlers));
      const context = createDirectChatContext({
        getRuntimeConfig: () => config,
        getGatewayMethodRegistry: () => methods,
        trackExecution: (run) => gatewayWork.track(run),
        pluginApprovalManager: manager,
        hasExecApprovalClients: () => true,
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      });
      const stopWatchingAuthority = registerAgentRunDelegatedAuthorityClosedHandler(
        (authority, reason) => {
          cancelAgentRuntimeBoundApprovals({
            authority,
            reason,
            manager,
            publish: () => {},
          });
        },
      );
      let native: Awaited<ReturnType<typeof registerNative>> | undefined;
      try {
        native = await registerNative(state, config, "approval-effect-agent.mjs");
        const attempt = await attemptFor(state, config, "opencode", "full");
        bindGatewayContextResolver(attempt.input.admittedRunContext, () => context);
        const entered = createDeferred<string>();
        const awaitDecision = manager.awaitDecision.bind(manager);
        vi.spyOn(manager, "awaitDecision").mockImplementation((id) => {
          const decision = awaitDecision(id);
          entered.resolve(id);
          return decision;
        });
        const abort = new AbortController();
        attempt.input.abortSignal = abort.signal;
        const run = runAgentHarnessAttempt(attempt.input);
        void run.catch(() => {});
        try {
          const approvalId = await Promise.race([
            entered.promise,
            run.then((result) => {
              throw new Error(
                `Attempt ended before approval wait: ${JSON.stringify(result.terminal)}`,
              );
            }),
          ]);
          expect(manager.listPendingRecords()).toHaveLength(1);
          expect(manager.getSnapshot(approvalId)).toMatchObject({
            request: {
              pluginId: "acpx",
              runId: attempt.input.runId,
              sessionKey: attempt.input.sessionKey,
              toolCallId: "native-write",
              allowedDecisions: ["allow-once", "deny"],
            },
          });
          expect(
            JSON.parse(await fs.readFile(state.path("peer", "permission-request.json"), "utf8")),
          ).toMatchObject({ toolCallId: "native-write", kind: "edit" });
          expect(await fs.readdir(state.path("peer", "effects"))).toEqual([]);
          if (kind === "cancel") {
            abort.abort();
          }
          // A late allow cannot revive the cancelled native permission request.
          const resolution = manager.resolveDetailed(
            approvalId,
            kind === "deny" ? "deny" : "allow-once",
            {
              kind: "device",
              id: "test-reviewer",
            },
          );
          expect(resolution.outcome).toBe(kind === "cancel" ? "already-resolved" : "resolved");
          const result = await run;
          expect(result.terminal).toMatchObject({
            kind: kind === "cancel" ? "aborted" : "ok",
          });
          expect(manager.listPendingRecords()).toEqual([]);
          if (kind === "cancel") {
            expect(manager.getSnapshot(approvalId)).toMatchObject({
              status: "cancelled",
              terminalReason: "run-aborted",
            });
          }
        } finally {
          abort.abort();
          attempt.close();
          await Promise.allSettled([run]);
        }
      } finally {
        stopWatchingAuthority();
        if (native) {
          await native.service.stop?.(native.context);
        }
        await manager.drain();
        await gatewayWork.drain();
      }
      // Inspect after shutdown so a late native permission reply cannot race this assertion.
      expect(await fs.readdir(state.path("peer", "effects"))).toEqual(
        kind === "allow" ? ["native-effect.txt"] : [],
      );
      if (kind === "deny") {
        expect(
          JSON.parse(await fs.readFile(state.path("peer", "permission-result.json"), "utf8")),
        ).toMatchObject({ outcome: { outcome: "selected", optionId: "deny" } });
      }
      if (kind === "allow") {
        expect(await fs.readFile(state.path("peer", "effects", "native-effect.txt"), "utf8")).toBe(
          "approved native effect",
        );
        expect(
          JSON.parse(await fs.readFile(state.path("peer", "permission-result.json"), "utf8")),
        ).toMatchObject({ outcome: { outcome: "selected", optionId: "allow" } });
      }
    });
  },
);
