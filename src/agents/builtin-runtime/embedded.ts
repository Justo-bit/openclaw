import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { setAgentLoopRunner } from "../../../packages/agent-core/src/loop-host.js";
import { readSecretFileSync } from "../../infra/secret-file.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import type { Agent } from "../runtime/index.js";
import { assertRuntimeUrl } from "./protocol.js";

/** Explicit opt-in applies only to built-in attempt sessions, never plugin/SDK agents. */
export async function attachBuiltinRuntimeServer(
  agent: Agent,
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "admittedRunContext" | "abortSignal" | "sessionId" | "runId" | "config"
  >,
  workspace: string,
): Promise<void> {
  const remote = attempt.config?.agents?.defaults?.embeddedAgent?.runtimeServer;
  if (!remote) {
    return;
  }
  const { url, gatewayId, tokenFile } = remote;
  assertRuntimeUrl(url);
  const assertActive = resolveAdmittedRunActiveAssertion(
    attempt.admittedRunContext,
    attempt.abortSignal,
  );
  if (!assertActive) {
    throw new Error("Separate built-in runtime requires admitted host authority");
  }
  assertActive();
  const token = readSecretFileSync(tokenFile, "Built-in runtime token", { maxBytes: 4096 });
  const workspaceId = createHash("sha256")
    .update(await realpath(workspace))
    .digest("hex");
  assertActive();
  // Resolve once per admitted attempt; continuations receive distinct attempt IDs.
  const { runRemoteBuiltinLoop } = await import("./host-loop.js");
  assertActive();
  setAgentLoopRunner(agent, (invocation) =>
    runRemoteBuiltinLoop(invocation, {
      url,
      token,
      assertActive,
      identity: {
        gatewayId,
        workspaceId,
        sessionId: attempt.sessionId,
        runId: attempt.runId,
        attemptId: randomUUID(),
      },
    }),
  );
}
