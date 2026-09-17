#!/usr/bin/env node
// Synthetic ACP peer: persists its own conversation so restart tests must really load it.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const directory = process.argv[2];
const modelControls = process.argv.slice(3).includes("--model-controls");
const sessions = new Map();
const configOptions = (state) => [
  {
    id: "tone",
    name: "Tone",
    type: "select",
    currentValue: state.tone,
    options: [
      { value: "plain", name: "Plain" },
      { value: "brief", name: "Brief" },
    ],
  },
  ...(modelControls
    ? [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: state.currentModelId,
          options: [
            { value: "initial", name: "Initial" },
            { value: "selected", name: "Selected" },
          ],
        },
      ]
    : []),
];
const describe = (state) => ({
  modes: {
    currentModeId: state.mode,
    availableModes: [
      { id: "normal", name: "Normal" },
      { id: "review", name: "Review" },
    ],
  },
  configOptions: configOptions(state),
});
const file = (id) => path.join(directory, `${id}.json`);
const save = (id) => fs.writeFile(file(id), JSON.stringify(sessions.get(id)));
const connection = new AgentSideConnection(
  (client) => ({
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
        authMethods: [],
      };
    },
    async newSession({ mcpServers }) {
      const sessionId = randomUUID();
      const state = {
        history: [],
        tone: "plain",
        mode: "normal",
        mcpServers,
        argv: process.argv.slice(3),
        ...(modelControls ? { currentModelId: "initial", modelChanges: [] } : {}),
      };
      sessions.set(sessionId, state);
      await save(sessionId);
      return { sessionId, ...describe(state) };
    },
    async loadSession({ sessionId, mcpServers }) {
      const state = JSON.parse(await fs.readFile(file(sessionId), "utf8"));
      state.loadedMcpServers = mcpServers;
      sessions.set(sessionId, state);
      return describe(state);
    },
    async setSessionMode({ sessionId, modeId }) {
      sessions.get(sessionId).mode = modeId;
      await save(sessionId);
      return {};
    },
    async setSessionConfigOption({ sessionId, configId, value }) {
      const state = sessions.get(sessionId);
      if (modelControls && configId === "model") {
        if (value !== "initial" && value !== "selected") {
          throw new Error("unknown model");
        }
        state.currentModelId = value;
        state.modelChanges.push(value);
      } else if (configId === "tone") {
        state.tone = value;
      } else {
        throw new Error("unknown option");
      }
      await save(sessionId);
      return { configOptions: configOptions(state) };
    },
    async prompt({ sessionId, prompt }) {
      const state = sessions.get(sessionId);
      state.history.push(
        prompt
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      );
      await save(sessionId);
      if (modelControls) {
        const effectsDirectory = path.join(directory, "effects");
        await fs.mkdir(effectsDirectory, { recursive: true });
        await fs.writeFile(
          path.join(effectsDirectory, `${sessionId}.txt`),
          state.history.join("\n"),
        );
      }
      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify({ sessionId, ...state }) },
        },
      });
      return { stopReason: "end_turn" };
    },
    async closeSession({ sessionId }) {
      sessions.delete(sessionId);
      await fs.rm(file(sessionId), { force: true });
      return {};
    },
    async cancel() {},
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
void connection;
