import { createAgentRegistry } from "acpx/agent-registry";
import { AcpxNativeAgentsSchema, type AcpxNativeAgentId } from "./config-schema.js";
import { resolveAcpxPluginConfig } from "./config.js";

type NativeAgentDescriptor = {
  id: AcpxNativeAgentId;
  name: string;
  runtimeId: string;
};

type AcpxNativeAgentStatus = NativeAgentDescriptor & {
  installation: "installed" | "missing" | "unverified";
  enabled: boolean;
};

export function isAcpxNativeAgentEnabled(flags: unknown, agent: AcpxNativeAgentId): boolean {
  return AcpxNativeAgentsSchema.parse(flags)?.[agent] !== false;
}

export function listAcpxNativeAgents(
  rawConfig: Record<string, unknown> | undefined,
  agents: readonly NativeAgentDescriptor[],
): AcpxNativeAgentStatus[] {
  const config = resolveAcpxPluginConfig({ rawConfig });
  const registry = createAgentRegistry({ overrides: config.agents });
  const enabled = AcpxNativeAgentsSchema.parse(rawConfig?.nativeAgents);
  return agents.map((agent): AcpxNativeAgentStatus => ({
    ...agent,
    installation: registry.inspect(agent.id)?.launch.kind ?? "unverified",
    enabled: enabled?.[agent.id] !== false,
  }));
}
