#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const directory = process.argv[2];
const describe = () => ({
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "selected",
      options: [{ value: "selected", name: "Selected" }],
    },
  ],
});

// The native peer owns this write. OpenClaw can prevent it only through the ACP reply.
const connection = new AgentSideConnection(
  (client) => ({
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
        authMethods: [],
      };
    },
    async newSession() {
      return { sessionId: randomUUID(), ...describe() };
    },
    async loadSession() {
      return describe();
    },
    async prompt({ sessionId }) {
      const toolCall = {
        toolCallId: "native-write",
        title: "Write the approved native effect",
        kind: "edit",
        status: "pending",
        rawInput: { path: "native-effect.txt", content: "approved native effect" },
      };
      await fs.writeFile(path.join(directory, "permission-request.json"), JSON.stringify(toolCall));
      const permission = await client.requestPermission({
        sessionId,
        toolCall,
        options: [
          { kind: "allow_once", name: "Allow once", optionId: "allow" },
          { kind: "reject_once", name: "Deny", optionId: "deny" },
        ],
      });
      await fs.writeFile(
        path.join(directory, "permission-result.json"),
        JSON.stringify(permission),
      );
      if (permission.outcome.outcome === "selected" && permission.outcome.optionId === "allow") {
        await fs.writeFile(
          path.join(directory, "effects", "native-effect.txt"),
          "approved native effect",
        );
      }
      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Native permission request settled." },
        },
      });
      return { stopReason: "end_turn" };
    },
    async closeSession() {
      return {};
    },
    async cancel() {},
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
void connection;
