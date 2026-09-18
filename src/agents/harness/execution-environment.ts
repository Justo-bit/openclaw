import type { AgentRuntimeRestrictionErrorDetails } from "../../../packages/gateway-protocol/src/agent-runtime-restriction-error-details.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { resolveExecConfigState } from "../exec-defaults.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../tool-fs-policy.js";
import { AgentHarnessPreflightError } from "./errors.js";
import type { AgentHarness } from "./types.js";

type ExecutionEnvironmentFacts = {
  sandboxed: boolean;
  sandboxRequired: boolean;
  workspaceOnly: boolean;
  permissionMode?: EmbeddedRunAttemptParams["permissionMode"];
  remoteExecution?: boolean;
};

type ExecutionRestriction = {
  reason: AgentRuntimeRestrictionErrorDetails["reason"];
  message: string;
};

/** Selection and invocation share this decision; a native working directory is not containment. */
export function resolveAgentHarnessExecutionRestriction(
  harness: Pick<AgentHarness, "label" | "executionEnvironment">,
  facts: ExecutionEnvironmentFacts,
): ExecutionRestriction | undefined {
  if (harness.executionEnvironment !== "host-only") {
    return undefined;
  }
  const label = harness.label;
  if (facts.sandboxRequired) {
    return {
      reason: "sandbox-required",
      message:
        label +
        " runs on the Gateway host, but this chat requires a sandbox. Choose another runtime; this requirement cannot be removed.",
    };
  }
  if (facts.remoteExecution) {
    return {
      reason: "remote-execution",
      message:
        label +
        " runs on the Gateway host and cannot use this chat's remote execution environment. Choose another runtime or a local chat.",
    };
  }
  if (facts.workspaceOnly) {
    return {
      reason: "workspace-only",
      message:
        label +
        " cannot enforce this chat's workspace-only file access. Choose another runtime or ask an administrator to review the file-access policy.",
    };
  }
  if (facts.sandboxed) {
    return {
      reason: "sandbox",
      message:
        label +
        " runs on the Gateway host, outside the sandbox. Run without sandbox for this chat, or choose another runtime.",
    };
  }
  if (facts.permissionMode && facts.permissionMode !== "full") {
    return {
      reason: "permission-mode",
      message:
        label +
        " uses its own permissions and requires Full access. Change this chat's permissions explicitly, or choose another runtime.",
    };
  }
  return undefined;
}

type ExecutionEnvironmentParams = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "agentId"
  | "sessionKey"
  | "sandboxSessionKey"
  | "sandboxAgentId"
  | "sandbox"
  | "permissionMode"
  | "requireWorkspaceOnly"
  | "execOverrides"
>;

/** Runs before native preparation and again at the shared invocation boundary. */
export function assertAgentHarnessExecutionEnvironment(
  harness: AgentHarness,
  params: ExecutionEnvironmentParams,
): void {
  if (harness.executionEnvironment !== "host-only") {
    return;
  }
  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    classificationSessionKey: params.sandboxSessionKey,
    classificationAgentId: params.sandboxAgentId,
  });
  const exec = resolveExecConfigState({
    cfg: params.config,
    agentId: runtime.classificationAgentId,
    sessionKey: params.sessionKey,
    execOverrides: params.execOverrides,
  });
  const restriction = resolveAgentHarnessExecutionRestriction(harness, {
    sandboxed: params.sandbox?.enabled === true || runtime.sandboxed || exec.host === "sandbox",
    sandboxRequired: runtime.sandboxRequired,
    workspaceOnly:
      params.requireWorkspaceOnly === true ||
      resolveEffectiveToolFsWorkspaceOnly({
        cfg: params.config,
        agentId: runtime.classificationAgentId,
      }),
    permissionMode: params.permissionMode,
    remoteExecution: exec.host === "node",
  });
  if (restriction) {
    throw new AgentHarnessPreflightError(restriction.message, {
      scope: "harness",
      userMessage: restriction.message,
    });
  }
}
