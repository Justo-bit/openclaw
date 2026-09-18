import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { resolveModelRuntimePolicy } from "../model-runtime-policy.js";

/** Placement is selected from policy, never Gateway credential availability. */
export function usesDedicatedBuiltinRuntime(
  params: {
    config?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
    agentHarnessId?: string;
    agentHarnessRuntimeOverride?: string;
  },
  provider: string,
  modelId: string,
): boolean {
  if (!params.config?.agents?.defaults?.embeddedAgent?.runtimeServer) {
    return false;
  }
  const explicit = normalizeOptionalAgentRuntimeId(
    params.agentHarnessId ?? params.agentHarnessRuntimeOverride,
  );
  const runtime =
    explicit && !isDefaultAgentRuntimeId(explicit)
      ? explicit
      : normalizeOptionalAgentRuntimeId(
          resolveModelRuntimePolicy({ ...params, provider, modelId }).policy?.id,
        );
  return isDefaultAgentRuntimeId(runtime) || runtime === "openclaw";
}
