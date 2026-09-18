---
summary: "Dedicated native inference with local credentials and Gateway-mediated tools"
title: "Built-in runtime server"
read_when:
  - You want a separate native inference process
  - You provision runtime-local model credentials and workspace views
---

# Built-in runtime server

The dedicated runtime executes the native OpenClaw agent loop **and opens its own
provider connections**. The Gateway keeps channel ingress, reply delivery, turn
admission, OpenClaw sessions/transcripts, tools, and operator approvals. Embedded
execution remains the default when the runtime-server opt-in is absent.

This is an OpenClaw-to-OpenClaw WebSocket protocol, not the Gateway protocol, ACP,
MCP, or the Codex app-server protocol. Use matching OpenClaw versions. The runtime
is trusted infrastructure: it receives conversation data and generates tool
requests, but cannot grant permission to execute them.

## Ownership

| Gateway                                               | Dedicated runtime                                   |
| ----------------------------------------------------- | --------------------------------------------------- |
| Channel ingress and reply delivery                    | Native agent loop and provider streaming            |
| Admitted run authority and cancellation               | Local provider/model registry and model credentials |
| Session/transcript persistence and context projection | Ephemeral native execution state                    |
| Tool implementations and approval decisions           | Startup-allowlisted workspace view                  |
| Tool result persistence and event delivery            | Native model events and provider connection state   |

There is no Gateway inference callback or provider-response proxy. A turn carries
provider/model identifiers, conversation data, tool schemas, and a scoped binding.
It does not carry provider credentials, endpoints, request headers, executable
configuration, or an arbitrary runtime filesystem path. The runtime resolves
connections and model credentials from trusted **local startup configuration**.

## Provision the runtime

Use a separate runtime service account or container. Do not copy or mount the
Gateway auth/state directory. Provision model credentials into this process's
startup environment with your service manager or secret provisioning system.
Never place them in chat, turn requests, or command-line arguments.

Create a separate random transport-auth token of at least 32 characters. Store it
in a private token file on each host (mode 0600 on POSIX). This authenticates the
Gateway/runtime connection; it is not a provider API key.

On the Gateway host, obtain the effective working-directory identifier:

```bash
openclaw runtime-workspace-id /gateway/workspaces/project
```

On the runtime host, create a private startup configuration. This is a **runtime
service configuration**, not a Gateway configuration:

```json validate=false
{
  "models": [
    {
      "provider": "openai",
      "id": "your-model-id",
      "api": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "contextWindow": 128000,
      "maxTokens": 8192,
      "reasoning": true,
      "thinkingLevelMap": { "xhigh": "xhigh", "max": "max" },
      "cost": {
        "input": "<input rate per million tokens>",
        "output": "<output rate per million tokens>",
        "cacheRead": "<cache-read rate per million tokens>",
        "cacheWrite": "<cache-write rate per million tokens>"
      },
      "apiKeyEnv": "NATIVE_OPENAI_API_KEY"
    }
  ],
  "workspaces": [
    {
      "id": "<gateway-workspace-sha256>",
      "path": "/runtime/workspace-views/project",
      "models": ["openai/your-model-id"]
    }
  ]
}
```

Replace the model identifier and token limits with your provisioned model. Replace
the four quoted cost placeholders with your actual numeric USD-per-million-token
rates. Every rate is required, finite, and nonnegative; zero deliberately declares
that token bucket free. Missing pricing fails startup rather than silently reporting
free inference. These are operator-provisioned estimates, not guessed catalog prices.

The optional `thinkingLevelMap` follows the canonical model contract: keys are
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; values are provider
mappings or `null` for unsupported levels. Only enable mappings that your model
supports. Unsupported selections fail before inference instead of being silently
downgraded. Pricing and thinking metadata are snapshotted and frozen at startup,
remain runtime-local, and cannot be replaced through the turn protocol.

The server snapshots explicitly named credential variables before startup admission.
Missing credentials fail startup; the server never consults Gateway profiles,
credentials, or environment. A local model may also specify a `headers` object.
Those headers are startup authority, never turn-request options.

Workspace paths are resolved on the runtime host. The server verifies canonical
directory identity at admission, before provider requests, and at settlement.
Retargeted symlinks or replaced directories fail closed. A workspace can restrict
its model references; omitted `models` permits its locally configured models.

This mapping is **not an OS sandbox**. Apply suitable service/container permissions
and read-only mounts. No local filesystem or shell tools are exposed by the
runtime: tool requests execute under the Gateway's existing policy and admitted
workspace. The two hosts may map the same logical workspace ID to different paths.

Start the service:

```bash
openclaw runtime-server --token-file /private/runtime-token --runtime-config /private/native-runtime.json --gateway-id gateway-a --port 18791
```

The listener binds only to loopback. For another host, use an SSH tunnel or TLS
reverse proxy forwarding Authorization and WebSocket upgrades. The client requires
`wss` outside loopback and refuses URL credentials, query strings, and redirects.
The server rejects browser Origin headers.

## Enable Gateway dispatch

Configure the endpoint and select the built-in OpenClaw runtime using its normal
runtime-selection controls. Explicit external harness selections stay separate.

```json5
{
  agents: {
    defaults: {
      embeddedAgent: {
        runtimeServer: {
          url: "ws://127.0.0.1:18791/runtime",
          gatewayId: "gateway-a",
          tokenFile: "/private/runtime-token",
        },
      },
    },
  },
}
```

The Gateway token-file path is local and never forwarded. Model identifiers must
match runtime configuration. Gateway display/context metadata is not provider
connection authority. Dedicated preparation does not initialize or rotate a
Gateway inference credential; Gateway tool credentials retain their separate
host-owned resolution path.

Native calls are persisted and finalized before execution is requested. The
runtime accepts the Gateway's finalized message acknowledgement, including changed
or removed tool blocks. Whole tool batches retain existing host argument
validation, preparation, approval, admission and execution checks. The runtime
cannot submit approval verdicts or generic Gateway RPC.

Remove `runtimeServer` to restore embedded execution for future attempts under
the normal config reload policy. Remove it before downgrading to an older version.
Existing installations need no migration; no SQLite schema/version change is
required.

## Protocol and lifecycle

HTTP upgrade authenticates the transport token. Each connection negotiates a
version range and receives version 1, a random server epoch, and a connection ID.
A connection owns exactly one turn.

Every callback, event, result, cancellation and terminal receipt carries Gateway,
workspace, session, run and attempt IDs plus epoch and connection ID. Request IDs
increase monotonically. Unknown, duplicate, stale and cross-owner results fail
closed. Opaque persistence acknowledgements preserve host transcript provenance
without serializing executable objects.

Native model events stream to the Gateway. Host tool events/results stream back
on their exact callback. The Gateway owns canonical transcript order and rechecks
live admitted authority; identifiers alone never authorize tools. Known local
credentials and credential-bearing header values are rejected if they appear in
outbound runtime payloads; ordinary header metadata is not treated as a secret.
Conversation/tool data must still be treated as private.

Frames are text JSON, limited to 16 MiB, with compression disabled. The server caps
connections at 128 and pending callbacks at 16. Initialization and turn start each
have a 10-second deadline. The Gateway attempt owns the overall budget, including
provider waits and approvals.

Version 1 does not resume or replay interrupted turns. Cancellation aborts native
provider execution and host callbacks. The Gateway retains its session fence until
already-started host work settles. Cancellation does not undo external effects;
inspect ordinary tool receipts before retrying.

Restart creates a new epoch. Old bindings, references and results cannot attach to
the replacement. New turns receive fresh provider connection/cache scopes and
Gateway-owned history. No native transcript database is created. SIGINT/SIGTERM
stops the runtime; replacing it does not deploy or restart the Gateway.

## Version 1 limits

- Thinking-level selection is supported. Other explicit request/model parameters
  (including sampling, output-token overrides, stop sequences, response formats,
  and enabled fast mode), custom thinking budgets, and non-default retry or
  connection settings fail before native inference rather than being silently
  ignored. Remove these overrides or use embedded execution. Configure
  `maxTokens` and `contextWindow` in the runtime-local startup model instead;
  Gateway endpoints, headers, and model credentials are never forwarded.
- Compaction (manual, budget, and overflow recovery) and branch summarization are
  unsupported for dedicated built-in execution. These operations fail explicitly
  before Gateway model credential lookup rather than falling back to Gateway
  inference. Ordinary embedded and explicitly selected external runtimes retain
  their existing compaction behavior.
- Built-in package API adapters are supported. Arbitrary provider-plugin loading
  or executable configuration is not accepted through startup files or turns.
- Ambient-configured Azure adapters and Vertex ambient-ADC marker credentials are
  rejected. Use an explicitly provisioned supported adapter.
- Model selection is fixed for an admitted turn; changing it requires a new turn.
- Queued steering is consumed at loop checkpoints. Separate streamed tool batches
  are serialized; parallel execution inside a host batch retains Gateway semantics.
- Rotate runtime-local model credentials with controlled runtime replacement. The
  Gateway never forwards a replacement model credential.

## Troubleshooting

- **Connection failure:** verify token files, exact Gateway ID, endpoint path,
  tunnel/TLS proxy, and matching versions.
- **Workspace/model denied:** check the Gateway workspace hash and runtime-local
  directory/model mapping. Do not send filesystem paths in turn requests.
- **Missing credential:** provision the named variable in the runtime service's
  startup environment, not in the Gateway.
- **Previous turn settling:** allow the already-started host operation to finish;
  do not force another owner or replay its requests.

No services are installed or deployed automatically. Existing Gateway service and
update procedures remain unchanged.
