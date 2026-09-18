import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { isEmbeddedAgentRunActive } from "../../agents/embedded-agent-runner/runs.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  hasAgentRunContextExecutionOwner,
  listAgentRunsForSession,
} from "../../infra/agent-run-registry.js";
import { isSessionWorkAdmissionActive } from "../../sessions/session-lifecycle-admission.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

/** Recheck authority and idle execution at preparation and the synchronous write boundary. */
export function validateSessionPatchSandboxChange(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  existingEntry: SessionEntry | undefined;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
  lifecycleIdentities: readonly (string | undefined)[];
}): ErrorShape | undefined {
  if (params.client !== null && !params.client.connect.scopes?.includes(ADMIN_SCOPE)) {
    return missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] });
  }
  if (params.entry.sandbox === "required" && params.entry.sandboxMode === "off") {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "This session requires a sandbox and cannot run without one.",
    );
  }
  if (params.existingEntry?.sandboxMode === params.entry.sandboxMode) {
    return undefined;
  }
  const sessionId = params.existingEntry?.sessionId;
  const placement = sessionId
    ? params.context.workerSessionPlacementService?.getMany([sessionId]).get(sessionId)
    : undefined;
  if (
    isSessionWorkAdmissionActive(params.storePath, params.lifecycleIdentities) ||
    (sessionId && isEmbeddedAgentRunActive(sessionId)) ||
    listAgentRunsForSession({ sessionKey: params.sessionKey, sessionId }).some(({ runId }) =>
      hasAgentRunContextExecutionOwner(runId),
    ) ||
    (placement?.executionMode === "worker-turn" && placement.turnClaim)
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "Stop the active run before changing this session's sandbox mode.",
    );
  }
  return undefined;
}
