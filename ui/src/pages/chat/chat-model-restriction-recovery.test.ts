/* @vitest-environment jsdom */

import { expect, it, onTestFinished } from "vitest";
import type { AgentRuntimeRestrictionErrorDetails } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { SessionsPatchResult } from "../../api/types.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import {
  getPendingChatPickerPatch,
  retireChatModelSelectionOwnership,
  switchChatModel,
} from "./chat-session.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";

const recovery = {
  action: "run-without-sandbox",
  sessionId: "original-incarnation",
  lifecycleRevision: "original-revision",
  expectedPermissionMode: "guarded",
  expectedSandboxMode: null,
} satisfies NonNullable<AgentRuntimeRestrictionErrorDetails["recovery"]>;

function fixture(
  options: {
    details?: Partial<AgentRuntimeRestrictionErrorDetails>;
    scopes?: string[];
    rejectRecovery?: boolean;
    unrestricted?: boolean;
  } = {},
) {
  const result = createSessionsListResult({ model: "original", modelProvider: "fixture" });
  result.sessions[0] = {
    ...result.sessions[0],
    key: "global",
    kind: "direct",
    updatedAt: 1,
    sessionId: recovery.sessionId,
    permissionMode: "guarded",
  };
  const details: AgentRuntimeRestrictionErrorDetails = {
    code: "AGENT_RUNTIME_RESTRICTED",
    runtimeId: "opencode",
    runtimeLabel: "OpenCode",
    reason: "sandbox",
    recovery,
    ...options.details,
  };
  let patches = 0;
  const receipt: SessionsPatchResult = {
    ok: true,
    key: "global",
    path: "",
    entry: { sessionId: recovery.sessionId, permissionMode: "full", updatedAt: 2 },
    resolved: { model: "selected", modelProvider: "fixture" },
  };
  const host = makeChatHost({
    sessionKey: "global",
    assistantAgentId: "selected-agent",
    agentsList: { defaultId: "main", scope: "global", agents: [{ id: "selected-agent" }] },
    hello: sessionMutationGatewayHello(options.scopes),
    sessionsResult: result,
    chatMessage: "Keep this draft; never replay it",
    requestHandlers: {
      "sessions.list": result,
      "sessions.patch": () => {
        patches += 1;
        if (patches === 1 && !options.unrestricted) {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Native runtime restricted",
            details,
          });
        }
        if (options.rejectRecovery) {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Session changed; select the model again",
          });
        }
        return options.unrestricted
          ? { ...receipt, entry: { ...receipt.entry, permissionMode: "guarded" } }
          : receipt;
      },
    },
  });
  onTestFinished(() => {
    retireChatModelSelectionOwnership(host);
    host.sessions.dispose();
  });
  return { host, receipt };
}

async function dialog() {
  await waitForFast(() => expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull());
  const modal = document.querySelector("openclaw-modal-dialog");
  if (!modal) {
    throw new Error("Expected native runtime confirmation");
  }
  return modal;
}

function click(modal: Element, label: string) {
  const button = Array.from(modal.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) {
    throw new Error("Missing confirmation action: " + label);
  }
  button.click();
}

it.each([false, true])(
  "requires explicit consent and handles a rejected recovery=%s without replay",
  async (rejectRecovery) => {
    const { host } = fixture({ rejectRecovery });
    const selection = switchChatModel(host, "fixture/selected", "global", "opencode");
    const modal = await dialog();
    expect(modal.textContent).toContain("full access");
    expect(modal.textContent).toContain("Gateway host");
    expect(modal.textContent).toContain("only this chat");
    expect(host.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(
      1,
    );
    click(modal, "Run without sandbox");
    await expect(selection).resolves.toBe(!rejectRecovery);
    const patches = host.request.mock.calls.filter(([method]) => method === "sessions.patch");
    expect(patches).toHaveLength(2);
    expect(patches[1]?.[1]).toEqual({
      key: "global",
      agentId: "selected-agent",
      expectedSessionId: recovery.sessionId,
      model: "fixture/selected",
      agentRuntime: "opencode",
      sandboxMode: "off",
      permissionMode: "full",
      expectedLifecycleRevision: recovery.lifecycleRevision,
      expectedPermissionMode: "guarded",
      expectedSandboxMode: null,
    });
    expect(
      host.request.mock.calls.some(
        ([method]) => method === "chat.send" || method.startsWith("config."),
      ),
    ).toBe(false);
    expect(host.chatMessage).toBe("Keep this draft; never replay it");
    expect(host.chatError ?? null).toEqual(
      rejectRecovery ? expect.stringContaining("Session changed") : null,
    );
  },
);

it.each([
  {
    name: "mandatory sandbox",
    details: { reason: "sandbox-required" as const, recovery: undefined },
  },
  { name: "no feasible recovery", details: { recovery: undefined } },
  { name: "write-only operator", scopes: ["operator.write"] },
  {
    name: "different incarnation",
    details: { recovery: { ...recovery, sessionId: "replacement" } },
  },
])("does not offer a bypass for $name", async (options) => {
  const { host } = fixture(options);
  await expect(switchChatModel(host, "fixture/selected", "global", "opencode")).resolves.toBe(
    false,
  );
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(host.chatError).toContain("Choose another model");
  expect(host.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
});

it.each([
  "cancel",
  "connection",
  "epoch",
  "session",
  "agent",
  "reset",
  "authority",
  "retired",
  "newer-selection",
] as const)("does not apply confirmation after %s", async (change) => {
  const { host } = fixture();
  const selection = switchChatModel(host, "fixture/selected", "global", "opencode");
  const modal = await dialog();
  switch (change) {
    case "cancel":
      break;
    case "connection":
      host.client = createTestGatewayClient(host.request);
      break;
    case "epoch":
      host.connectionEpoch = (host.connectionEpoch ?? 0) + 1;
      break;
    case "session":
      host.sessionKey = "agent:main:other";
      break;
    case "agent":
      host.assistantAgentId = "other-agent";
      break;
    case "reset":
      host.sessionsResult!.sessions[0]!.sessionId = "replacement";
      break;
    case "authority":
      host.hello = sessionMutationGatewayHello(["operator.write"]);
      break;
    case "retired":
      retireChatModelSelectionOwnership(host);
      break;
    case "newer-selection":
      await switchChatModel(host, "fixture/newer", "global", "openclaw");
      break;
  }
  if (change === "newer-selection" || change === "retired") {
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  } else {
    click(modal, change === "cancel" ? "Cancel" : "Run without sandbox");
  }
  await expect(selection).resolves.toBe(false);
  const patches = host.request.mock.calls.filter(([method]) => method === "sessions.patch");
  expect(
    patches.some(([, params]) => params && typeof params === "object" && "sandboxMode" in params),
  ).toBe(false);
  expect(patches).toHaveLength(change === "newer-selection" ? 2 : 1);
  expect(host.chatMessage).toBe("Keep this draft; never replay it");
});

it("rechecks a confirmed recovery after the shared settings tail, before dispatch", async () => {
  const { host, receipt } = fixture();
  const selection = switchChatModel(host, "fixture/selected", "global", "opencode");
  const modal = await dialog();
  const held = createDeferred<SessionsPatchResult>();
  host.request.mockImplementationOnce(async () => held.promise);
  const pending = patchChatSessionSettings(
    host,
    "global",
    { thinkingLevel: "high" },
    { agentId: "selected-agent" },
  );
  await waitForFast(() =>
    expect(host.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(
      2,
    ),
  );
  const previousTail = getPendingChatPickerPatch(host, "global", "selected-agent");
  click(modal, "Run without sandbox");
  // Observe admission behind the held mutation before revoking UI authority.
  await waitForFast(() =>
    expect(getPendingChatPickerPatch(host, "global", "selected-agent")).not.toBe(previousTail),
  );
  host.hello = sessionMutationGatewayHello(["operator.write"]);
  held.resolve(receipt);
  await pending;
  await expect(selection).resolves.toBe(false);
  expect(host.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(2);
});

it("does not open a late refusal on a replacement connection", async () => {
  const { host } = fixture();
  const response = createDeferred<SessionsPatchResult>();
  host.request.mockImplementationOnce(() => response.promise);
  const selection = switchChatModel(host, "fixture/selected", "global", "opencode");
  host.connectionEpoch = (host.connectionEpoch ?? 0) + 1;
  response.reject(
    new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "Native runtime restricted",
      details: {
        code: "AGENT_RUNTIME_RESTRICTED",
        runtimeId: "opencode",
        runtimeLabel: "OpenCode",
        reason: "sandbox",
        recovery,
      },
    }),
  );
  await expect(selection).resolves.toBe(false);
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(host.chatError ?? null).toBeNull();
  expect(host.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
});

it("leaves an unrestricted model selection on the ordinary patch path", async () => {
  const { host } = fixture({ unrestricted: true });
  await expect(switchChatModel(host, "fixture/selected", "global", "opencode")).resolves.toBe(true);
  const patches = host.request.mock.calls.filter(([method]) => method === "sessions.patch");
  expect(patches).toHaveLength(1);
  expect(patches[0]?.[1]).toEqual({
    key: "global",
    agentId: "selected-agent",
    model: "fixture/selected",
    agentRuntime: "opencode",
  });
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(host.chatError ?? null).toBeNull();
});
