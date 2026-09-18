import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import manifest from "../openclaw.plugin.json" with { type: "json" };

type RunCommandBuffered =
  (typeof import("openclaw/plugin-sdk/process-runtime"))["runCommandBuffered"];
const processRuntimeMocks = vi.hoisted(() => ({
  runCommandBuffered: vi.fn<RunCommandBuffered>(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandBuffered: processRuntimeMocks.runCommandBuffered,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionId = "01a0c710-4cad-7049-858e-b5a9fb33c013";

const completeResume: RunCommandBuffered = async (argv, options) => {
  const outputPath = argv[argv.indexOf("--output-last-message") + 1];
  const codexHome = options?.env?.CODEX_HOME;
  if (!outputPath || !codexHome) {
    throw new Error("missing Codex output path or home");
  }
  await fs.writeFile(outputPath, await fs.realpath(codexHome));
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
};

async function createRegisteredResume() {
  const stateDir = tempDirs.make("codex-node-reservations-");
  const alphaDir = path.join(stateDir, "alpha");
  const betaDir = path.join(stateDir, "beta");
  const alphaHome = path.join(alphaDir, "codex-home");
  const betaHome = path.join(betaDir, "codex-home");
  const aliasHome = path.join(stateDir, "native-home");
  await fs.mkdir(alphaHome, { recursive: true });
  await fs.mkdir(betaHome, { recursive: true });
  await fs.symlink(alphaHome, aliasHome, process.platform === "win32" ? "junction" : "dir");
  vi.stubEnv("CODEX_HOME", aliasHome);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  const pluginConfig = {
    appServer: { transport: "stdio", homeScope: "agent" },
    sessionCatalog: { enabled: false },
  };
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { alpha: { agentDir: alphaDir }, beta: { agentDir: betaDir } },
    },
    plugins: { entries: { codex: { enabled: true, config: pluginConfig } } },
  };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const registry = createPluginRegistry({
    runtime: createPluginRuntimeMock({ config: { current: () => config } }),
    logger,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: manifest.id,
    source: path.join(stateDir, "index.js"),
    nativeSessionCatalog: manifest.setup.nativeSessionCatalog,
  });
  registry.registry.plugins.push(record);
  plugin.register(registry.createApi(record, { config, pluginConfig }));
  const command = registry.registry.nodeHostCommands.find(
    (entry) => entry.command.command === "codex.cli.session.resume",
  )?.command;
  if (!command) {
    throw new Error("Codex resume command did not register");
  }
  return {
    alphaHome: await fs.realpath(alphaHome),
    betaHome: await fs.realpath(betaHome),
    command,
    request: (agentId?: string) =>
      JSON.stringify({ sessionId, prompt: "continue", cwd: stateDir, agentId }),
    stop: () =>
      registry.registry.services
        .find((entry) => entry.service.id === "codex-session-catalog")
        ?.service.stop?.({ config, stateDir, logger }),
  };
}

describe("registered Codex node resume reservations", () => {
  beforeEach(() => {
    processRuntimeMocks.runCommandBuffered.mockReset().mockImplementation(completeResume);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs copied thread ids concurrently in distinct configured homes", async () => {
    const fixture = await createRegisteredResume();
    const alphaStarted = createDeferred<void>();
    const betaStarted = createDeferred<void>();
    const release = createDeferred<void>();
    processRuntimeMocks.runCommandBuffered.mockImplementation(async (argv, options) => {
      const home = await fs.realpath(options?.env?.CODEX_HOME ?? "");
      if (home === fixture.alphaHome) {
        alphaStarted.resolve();
      } else if (home === fixture.betaHome) {
        betaStarted.resolve();
      } else {
        throw new Error("unexpected Codex home");
      }
      await release.promise;
      return completeResume(argv, options);
    });
    let alpha: Promise<string> | undefined;
    let beta: Promise<string> | undefined;
    try {
      alpha = fixture.command.handle(fixture.request("alpha"));
      await Promise.race([alphaStarted.promise, alpha]);
      beta = fixture.command.handle(fixture.request("beta"));
      await expect(Promise.race([betaStarted.promise.then(() => "started"), beta])).resolves.toBe(
        "started",
      );
      expect(processRuntimeMocks.runCommandBuffered).toHaveBeenCalledTimes(2);
      release.resolve();
      expect(JSON.parse(await alpha)).toMatchObject({ text: fixture.alphaHome });
      expect(JSON.parse(await beta)).toMatchObject({ text: fixture.betaHome });
    } finally {
      release.resolve();
      await Promise.allSettled([alpha, beta]);
      await fixture.stop();
    }
  });

  it.each(["catalog", "legacy"] as const)(
    "keeps home aliases mutually exclusive until a canceled %s turn settles",
    async (route) => {
      const fixture = await createRegisteredResume();
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      processRuntimeMocks.runCommandBuffered.mockImplementationOnce(async (argv, options) => {
        expect(await fs.realpath(options?.env?.CODEX_HOME ?? "")).toBe(fixture.alphaHome);
        started.resolve();
        await release.promise;
        return completeResume(argv, options);
      });
      const controller = new AbortController();
      const running = fixture.command.handle(
        fixture.request(route === "catalog" ? "alpha" : undefined),
        undefined,
        { signal: controller.signal, sendNodeEvent: async () => undefined },
      );
      const outcome = running.then(
        (value) => value,
        (error: unknown) => error,
      );
      try {
        await expect(Promise.race([started.promise.then(() => "started"), outcome])).resolves.toBe(
          "started",
        );
        for (const canceled of [false, true]) {
          if (canceled) {
            controller.abort(new Error("node invocation canceled"));
          }
          for (const agentId of ["alpha", undefined]) {
            await expect(fixture.command.handle(fixture.request(agentId))).rejects.toThrow(
              "already has an active resume turn",
            );
          }
          expect(processRuntimeMocks.runCommandBuffered).toHaveBeenCalledOnce();
        }
        release.resolve();
        expect(await outcome).toMatchObject({ message: "node invocation canceled" });
        for (const agentId of ["alpha", undefined]) {
          expect(JSON.parse(await fixture.command.handle(fixture.request(agentId)))).toMatchObject({
            ok: true,
            text: fixture.alphaHome,
          });
        }
        expect(processRuntimeMocks.runCommandBuffered).toHaveBeenCalledTimes(3);
      } finally {
        release.resolve();
        await outcome;
        await fixture.stop();
      }
    },
  );
});
