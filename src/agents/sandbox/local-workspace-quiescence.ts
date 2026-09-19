import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  bindPodmanSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
  execContainer,
  validateSandboxContainerEngineTarget,
} from "./docker.js";
import {
  readRegistry,
  readBrowserRegistry,
  assertSandboxRegistryEntryCurrent,
  assertSandboxBrowserRegistryEntryCurrent,
  type SandboxRegistryEntry,
} from "./registry.js";

/** Both execution and browser runtimes can write the exact private mount. */
export async function readLocalWorkspaceRuntimes(workspaceDir: string): Promise<
  Array<{
    kind: "container" | "browser";
    entry: SandboxRegistryEntry;
    assertCurrent: () => void;
  }>
> {
  const [containers, browsers] = await Promise.all([readRegistry(), readBrowserRegistry()]);
  return [
    ...containers.entries
      .filter((entry) => entry.workspaceDir === workspaceDir)
      .map((entry) => ({
        kind: "container" as const,
        entry,
        assertCurrent: () => assertSandboxRegistryEntryCurrent(entry),
      })),
    ...browsers.entries
      .filter((entry) => entry.workspaceDir === workspaceDir)
      .map((entry) => ({
        kind: "browser" as const,
        entry: { ...entry, backendId: "docker" } satisfies SandboxRegistryEntry,
        assertCurrent: () => assertSandboxBrowserRegistryEntryCurrent(entry),
      })),
  ];
}

export type LocalWorkspacePausedRuntime = { name: string; id: string };

export function parseLocalWorkspacePausedRuntimes(
  raw: string | null,
): LocalWorkspacePausedRuntime[] {
  if (!raw) {
    return [];
  }
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error("Invalid local workspace runtime custody");
  }
  return value.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(entry.name) ||
      typeof entry.id !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.id)
    ) {
      throw new Error("Invalid local workspace runtime custody");
    }
    return { name: entry.name, id: entry.id };
  });
}

/** Caller holds the projection lease through pause, reconciliation, and resume. */
export async function quiesceLocalWorkspace(params: {
  workspaceDir: string;
  retained: LocalWorkspacePausedRuntime[];
  persist: (runtimes: LocalWorkspacePausedRuntime[]) => void;
  assertCurrent: () => void;
}) {
  const selected = await readLocalWorkspaceRuntimes(params.workspaceDir);
  params.assertCurrent();
  const paused = [...params.retained];
  const releases: Array<() => Promise<void>> = [];
  for (const runtime of selected) {
    const { entry } = runtime;
    if (entry.backendId !== "docker" && entry.backendId !== "podman") {
      throw new Error("Local workspace backend cannot fence host projection writes");
    }
    if (entry.backendId === "podman" && !entry.backendTarget) {
      throw new Error("Local workspace Podman engine owner is missing");
    }
    const engine =
      entry.backendId === "podman"
        ? bindPodmanSandboxEngine(entry.backendTarget!)
        : DOCKER_SANDBOX_ENGINE;
    await validateSandboxContainerEngineTarget(engine, entry.backendTarget);
    params.assertCurrent();
    runtime.assertCurrent();
    const inspect = await execContainer(
      engine,
      ["inspect", "-f", "{{.Id}} {{.State.Running}} {{.State.Paused}}", entry.containerName],
      { allowFailure: true },
    );
    params.assertCurrent();
    if (inspect.code !== 0) {
      if (/no such (?:container|object)|does not exist/iu.test(inspect.stderr)) {
        continue;
      }
      throw new Error("Local workspace runtime could not be inspected; workspace preserved");
    }
    const [id, running, isPaused] = inspect.stdout.trim().split(/\s+/u);
    if (
      !id ||
      !/^[a-f0-9]{64}$/u.test(id) ||
      !["true", "false"].includes(running ?? "") ||
      !["true", "false"].includes(isPaused ?? "")
    ) {
      throw new Error("Invalid local workspace runtime inspection");
    }
    if (running !== "true") {
      continue;
    }
    const retained = paused.some(
      (retainedRuntime) =>
        retainedRuntime.name === entry.containerName && retainedRuntime.id === id,
    );
    if (isPaused === "true" && !retained) {
      throw new Error(
        "Local workspace runtime was paused by another owner; resume it before retrying",
      );
    }
    if (!retained) {
      paused.push({ name: entry.containerName, id });
      params.persist(paused);
    }
    if (isPaused !== "true") {
      params.assertCurrent();
      runtime.assertCurrent();
      await execContainer(engine, ["pause", id]);
    }
    releases.push(async () => {
      const result = await execContainer(engine, ["unpause", id], { allowFailure: true });
      if (
        result.code !== 0 &&
        !/no such (?:container|object)|does not exist/iu.test(result.stderr)
      ) {
        throw new Error("Local workspace runtime resume failed; exact paused owner retained");
      }
    });
  }
  return async () => {
    for (const release of releases.toReversed()) {
      await release();
    }
    params.persist([]);
  };
}
