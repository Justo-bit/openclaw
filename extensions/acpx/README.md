# @openclaw/acpx

Official ACP runtime backend for OpenClaw.

ACPx lets OpenClaw run external coding harnesses through the Agent Client Protocol while OpenClaw still owns sessions, channels, delivery, permissions, and Gateway state.

## Install

```bash
openclaw plugins install @openclaw/acpx
```

Restart the Gateway after installing or updating the plugin.

## What it provides

- ACP-backed agent runtime sessions.
- Plugin-owned session and transport management.
- MCP bridge helpers for OpenClaw tools and plugin tools.
- Static runtime assets used by the ACP process bridge.

## Native agents in the model picker

Install OpenCode, Qwen Code, Pi ACP, or Kilo Code and complete its login on the Gateway host,
then refresh the model catalog. Choose one of its models to use that agent in ordinary chat.
The agent owns its credentials; OpenClaw keeps the conversation transcript and asks for approval
when the agent requests permission. Pi does not request tool approval unless an extension adds it.
The same selection works in the web app and channels.

The runtime and provider IDs are `acp-opencode`, `acp-qwen`, `acp-pi`, and `acp-kilocode`.
Each model keeps its native ID, including any slashes. Configured ACP agent commands take
precedence over installed defaults. Catalog refresh uses installed commands and does not install
missing agents. Explicit ACP commands and bindings keep their existing agent names.

Models settings lists detected agents on the Gateway machine. Turn each native agent on or off
there, or set `plugins.entries.acpx.config.nativeAgents.<id>` to `false` (`opencode`, `qwen`,
`pi`, or `kilocode`). Missing flags are enabled. Disabling an agent prevents new native turns
and catalog discovery without interrupting a running turn or deleting history. Classic ACP
commands and `acp.allowedAgents` keep their existing behavior. Detection checks installed
executables; it does not prove that an agent is logged in or can serve a model.

The picker runtime cannot enforce OpenClaw's Read Only, Guarded, or Workspace permission modes.
It rejects those explicit modes before starting the agent. Use Full access with the agent's own
permission policy, or choose another runtime for those OpenClaw restrictions.

Catalog refresh closes its local connection. The native agent owns any history it creates.
Reset and deletion close the local session and prevent its reuse, including after a Gateway restart.
Native history stays with the agent; these operations do not delete it.

## Configure

Use the ACP docs for harness-specific setup, permission modes, and model/runtime selection:

- https://docs.openclaw.ai/tools/acp-agents-setup
- https://docs.openclaw.ai/tools/acp-agents

## Package

- Plugin id: `acpx`
- Package: `@openclaw/acpx`
- Minimum OpenClaw host: `2026.4.25`
