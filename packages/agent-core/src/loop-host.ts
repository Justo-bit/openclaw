import type { AssistantMessage } from "@openclaw/llm-core";
import type { AgentEventSink, ExecutedToolCallBatch } from "./agent-stream-response.js";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentToolCall } from "./types.js";

/** Private instance-scoped loop dispatch. Provider execution is never a host callback. */
export type LoopInvocation = {
  prompts?: AgentMessage[];
  context: AgentContext;
  config: AgentLoopConfig;
  emit: AgentEventSink;
  signal: AbortSignal;
};
export type LoopRunner = (input: LoopInvocation) => Promise<void>;
const runners = new WeakMap<object, LoopRunner>();
export function setAgentLoopRunner(agent: object, runner: LoopRunner): void {
  runners.set(agent, runner);
}
export function getAgentLoopRunner(agent: object): LoopRunner | undefined {
  return runners.get(agent);
}

export type LoopToolsInput = {
  context: AgentContext;
  message: AssistantMessage;
  calls: AgentToolCall[];
  criticalToolLoopSeen: boolean;
  steeringMessages: AgentMessage[];
  hasStreamedTools: boolean;
};
/** Complete tool batches cross the boundary; private host admission stays adjacent to execution. */
export type AgentLoopHost = {
  tools: (
    input: LoopToolsInput,
    emit: AgentEventSink,
    signal?: AbortSignal,
  ) => Promise<ExecutedToolCallBatch>;
  consumeCancellation: (message: AgentMessage) => Promise<boolean>;
};
const hosts = new WeakMap<AgentLoopConfig, AgentLoopHost>();
export function setAgentLoopHost(config: AgentLoopConfig, host: AgentLoopHost): void {
  hosts.set(config, host);
}
export function getAgentLoopHost(config: AgentLoopConfig): AgentLoopHost | undefined {
  return hosts.get(config);
}
export type LocalLoopEffects = {
  config: AgentLoopConfig;
  signal?: AbortSignal;
  emit: AgentEventSink;
};
