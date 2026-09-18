import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const credentialName = "RUNTIME_DOTENV_PROOF_CREDENTIAL";
const entry = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli);

async function fixture(scope: "cwd" | "global") {
  const root = tempDirs.make("openclaw-runtime-dotenv-");
  const stateDir = path.join(root, "state");
  const cwd = path.join(root, "workspace");
  await fs.mkdir(stateDir);
  await fs.mkdir(cwd);
  const tokenFile = path.join(root, "token");
  const configFile = path.join(root, "runtime.json");
  await fs.writeFile(tokenFile, "synthetic-listener-token", { mode: 0o600 });
  await fs.writeFile(
    configFile,
    JSON.stringify({
      models: [
        {
          provider: "openai",
          id: "fixture",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:1/v1",
          contextWindow: 4096,
          maxTokens: 32,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          apiKeyEnv: credentialName,
        },
      ],
      workspaces: [{ id: "fixture", path: cwd }],
    }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(scope === "cwd" ? cwd : stateDir, ".env"),
    credentialName + "=synthetic-dotenv-only\n",
  );
  // Deliberately do not spread the host environment into this credential-boundary child.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_NO_RESPAWN: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    ESBUILD_WORKER_THREADS: "0",
  };
  const args = [
    "runtime-server",
    "--token-file",
    tokenFile,
    "--runtime-config",
    configFile,
    "--gateway-id",
    "fixture",
    "--port",
    "18791",
  ];
  return { root, cwd, stateDir, env, args };
}

// The observer only records exit-time state; entry, run-main, Commander, dotenv,
// and native credential admission all execute unmodified in the child.
async function observeExit(root: string) {
  const report = path.join(root, "exit-env.json");
  const preload = path.join(root, "observe.mjs");
  await fs.writeFile(
    preload,
    'import fs from "node:fs"; process.on("exit", () => fs.writeFileSync(' +
      JSON.stringify(report) +
      ", JSON.stringify({credential: process.env[" +
      JSON.stringify(credentialName) +
      "] ?? null})));",
  );
  return { report, preload };
}

describe("native runtime production CLI dotenv boundary", () => {
  it.each(["cwd", "global"] as const)(
    "rejects credentials supplied only by %s .env",
    async (scope) => {
      const f = await fixture(scope);
      const observer = await observeExit(f.root);
      const result = await runCliProcessChild({
        nodeArgs: ["--import", observer.preload, ...resolveRuntimeWorkerArgv(entry), ...f.args],
        env: f.env,
        cwd: f.cwd,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ code: 1, signal: null });
      expect(result.stderr).toContain(
        "Missing native runtime credential environment variable: " + credentialName,
      );
      expect(result.stdout + result.stderr).not.toContain("Built-in runtime listening");
      expect(JSON.parse(await fs.readFile(observer.report, "utf8"))).toEqual({ credential: null });
    },
  );

  it("keeps diagnostic timeline config reads from importing global dotenv", async () => {
    const f = await fixture("global");
    const observer = await observeExit(f.root);
    const result = await runCliProcessChild({
      nodeArgs: ["--import", observer.preload, ...resolveRuntimeWorkerArgv(entry), ...f.args],
      env: { ...f.env, OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: path.join(f.root, "timeline.jsonl") },
      cwd: f.cwd,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ code: 1, signal: null });
    expect(result.stderr).toContain(
      "Missing native runtime credential environment variable: " + credentialName,
    );
    expect(JSON.parse(await fs.readFile(observer.report, "utf8"))).toEqual({ credential: null });
  });

  it.each(["cwd", "global"] as const)(
    "keeps workspace identity startup free of %s dotenv",
    async (scope) => {
      const f = await fixture(scope);
      const observer = await observeExit(f.root);
      const result = await runCliProcessChild({
        nodeArgs: [
          "--import",
          observer.preload,
          ...resolveRuntimeWorkerArgv(entry),
          "runtime-workspace-id",
          f.cwd,
        ],
        env: f.env,
        cwd: f.cwd,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ code: 0, signal: null });
      expect(result.stdout.trim()).toBe(
        createHash("sha256")
          .update(await fs.realpath(f.cwd))
          .digest("hex"),
      );
      expect(JSON.parse(await fs.readFile(observer.report, "utf8"))).toEqual({ credential: null });
    },
  );

  it.each(["runtime-server", "runtime-workspace-id"])(
    "keeps early argument diagnostics free of dotenv for %s",
    async (command) => {
      const f = await fixture("global");
      const observer = await observeExit(f.root);
      const result = await runCliProcessChild({
        nodeArgs: [
          "--import",
          observer.preload,
          ...resolveRuntimeWorkerArgv(entry),
          command,
          "--profile=bad/profile",
        ],
        env: f.env,
        cwd: f.cwd,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ code: 2, signal: null });
      expect(result.stderr).toContain("Invalid --profile");
      expect(JSON.parse(await fs.readFile(observer.report, "utf8"))).toEqual({ credential: null });
    },
  );

  it.each(["cwd", "global"] as const)(
    "preserves %s dotenv loading for other commands",
    async (scope) => {
      const f = await fixture(scope);
      const observer = await observeExit(f.root);
      const result = await runCliProcessChild({
        nodeArgs: [
          "--import",
          observer.preload,
          ...resolveRuntimeWorkerArgv(entry),
          "config",
          "file",
        ],
        env: f.env,
        cwd: f.cwd,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ code: 0, signal: null });
      expect(JSON.parse(await fs.readFile(observer.report, "utf8"))).toEqual({
        credential: "synthetic-dotenv-only",
      });
    },
  );
});
