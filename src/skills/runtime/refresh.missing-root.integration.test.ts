import { AsyncLocalStorage } from "node:async_hooks";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

it.each(["initial", "closed", "disabled", "evicted"] as const)(
  "reads repaired skills immediately after %s watcher acquisition",
  async (lifecycle) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-acquire-")));
    const workspaceDir = path.join(root, "workspace");
    const skillDir = path.join(workspaceDir, "skills", "acquire-proof");
    const skillFile = path.join(skillDir, "SKILL.md");
    const { ensureSkillsWatcher, closeSkillsWatchers } = await import("./refresh.js");
    const { getSkillsSnapshotVersion } = await import("./refresh-state.js");
    const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
    const options = { config: {}, agentId: "main" };
    try {
      await fs.mkdir(skillDir, { recursive: true });
      if (lifecycle !== "initial") {
        ensureSkillsWatcher({ workspaceDir, ...options });
        if (lifecycle === "closed") {
          await closeSkillsWatchers();
        } else if (lifecycle === "disabled") {
          ensureSkillsWatcher({
            workspaceDir,
            ...options,
            config: { skills: { load: { watch: false } } },
          });
        } else {
          const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60_000);
          try {
            ensureSkillsWatcher({ workspaceDir: path.join(root, "other"), ...options });
          } finally {
            clock.mockRestore();
          }
        }
      }
      // Cache the invalid file after teardown, so teardown invalidation cannot
      // accidentally prove freshness on reacquisition.
      nativeFs.writeFileSync(skillFile, "not valid skill frontmatter\n");
      const readSkill = () =>
        loadWorkspaceSkills(workspaceDir, options).find(
          (entry) => entry.skill.name === "acquire-proof",
        );
      expect(readSkill()).toBeUndefined();
      nativeFs.writeFileSync(
        skillFile,
        "---\nname: acquire-proof\ndescription: Repaired before acquisition\n---\n",
      );
      expect(readSkill()).toBeUndefined();
      // No await: the first synchronous consumer must not need a ready/change event.
      ensureSkillsWatcher({ workspaceDir, ...options });
      expect(readSkill()?.skill.description).toBe("Repaired before acquisition");
      const version = getSkillsSnapshotVersion(workspaceDir);
      ensureSkillsWatcher({ workspaceDir, ...options });
      expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
    } finally {
      await closeSkillsWatchers();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["create", "edit"] as const)(
  "refreshes cached skills after %s during initial watcher registration",
  async (operation) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-scan-proof-")));
    const workspaceDir = path.join(root, "workspace");
    const skillDir = path.join(workspaceDir, "skills", "scan-proof");
    const skillFile = path.join(skillDir, "SKILL.md");
    const contents = (description: string) =>
      `---\nname: scan-proof\ndescription: ${description}\n---\n`;
    const { ensureSkillsWatcher, closeSkillsWatchers } = await import("./refresh.js");
    const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
    const options = { config: {}, agentId: "main" };
    try {
      await fs.mkdir(path.dirname(skillDir), { recursive: true });
      if (operation === "edit") {
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(skillFile, contents("Before registration"));
      }
      ensureSkillsWatcher({ workspaceDir, ...options });
      const cached = loadWorkspaceSkills(workspaceDir, options);
      expect(cached.find((entry) => entry.skill.name === "scan-proof")?.skill.description).toBe(
        operation === "edit" ? "Before registration" : undefined,
      );
      // Keep the write in this turn, before native watcher registration, so
      // refresh cannot depend on receiving a subsequent file-change event.
      nativeFs.mkdirSync(skillDir, { recursive: true });
      nativeFs.writeFileSync(skillFile, contents("After registration"));
      await expect
        .poll(
          () =>
            loadWorkspaceSkills(workspaceDir, options).find(
              (entry) => entry.skill.name === "scan-proof",
            )?.skill.description,
          { timeout: 3_000 },
        )
        .toBe("After registration");
    } finally {
      await closeSkillsWatchers();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it("refreshes skills created beneath an initially missing project skills root", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-root-proof-")));
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(path.join(workspaceDir, "skills", "existing"), { recursive: true });
  const registeredPaths = new Set<string>();
  const turnContext = new AsyncLocalStorage<string>();
  const pendingInputContext = new AsyncLocalStorage<string>();
  const inheritedContexts: Array<{ turn?: string; pendingInput?: string }> = [];
  const originalWatch = nativeFs.watch;
  const watchObserver = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
    inheritedContexts.push({
      turn: turnContext.getStore(),
      pendingInput: pendingInputContext.getStore(),
    });
    const watcher = originalWatch(...args);
    registeredPaths.add(path.resolve(String(args[0])));
    return watcher;
  });
  syncBuiltinESMExports();
  const { ensureSkillsWatcher, closeSkillsWatchers, registerSkillsChangeListener } =
    await import("./refresh.js");
  const changes: string[] = [];
  let readyEvents = 0;
  const unregister = registerSkillsChangeListener((event) => {
    if (event.workspaceDir !== workspaceDir) {
      return;
    }
    if (event.reason === "watch") {
      if (event.changedPath) {
        changes.push(event.changedPath);
      } else {
        readyEvents += 1;
      }
    }
  });
  try {
    turnContext.run("active turn", () => {
      pendingInputContext.run("accepted input", () => {
        ensureSkillsWatcher({ workspaceDir });
        expect(turnContext.getStore()).toBe("active turn");
        expect(pendingInputContext.getStore()).toBe("accepted input");
      });
    });
    const existingSkill = path.join(workspaceDir, "skills", "existing", "SKILL.md");
    // This control covers writes after registration; the cases above cover
    // cached discovery while the initial scan is still pending. Wait for the
    // public ready invalidations because Bun cannot observe Chokidar's already-
    // bound node:fs export through the spy below.
    await vi.waitFor(() => {
      expect(readyEvents).toBe(1);
    });
    // Bun does not project spy replacements onto already-bound node:fs named exports.
    if (!process.versions.bun) {
      await vi.waitFor(() => {
        expect(registeredPaths.has(workspaceDir)).toBe(true);
        expect(registeredPaths.has(path.dirname(existingSkill))).toBe(true);
      });
    }
    await fs.writeFile(existingSkill, "existing skill");
    await vi.waitFor(() => expect(changes).toContain(existingSkill), { timeout: 3_000 });
    const newSkill = path.join(workspaceDir, ".agents", "skills", "new", "SKILL.md");
    await fs.mkdir(path.dirname(newSkill), { recursive: true });
    await fs.writeFile(newSkill, "new skill");
    await vi.waitFor(
      () => {
        expect(
          changes.some((changed) => changed.startsWith(path.join(workspaceDir, ".agents"))),
        ).toBe(true);
      },
      { timeout: 3_000 },
    );
    if (!process.versions.bun) {
      expect(inheritedContexts.length).toBeGreaterThan(0);
      for (const context of inheritedContexts) {
        expect(context).toEqual({ turn: undefined, pendingInput: undefined });
      }
    }
  } finally {
    unregister();
    await closeSkillsWatchers();
    watchObserver.mockRestore();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("shared missing skill ancestors", () => {
  const roots = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      const { closeSkillsWatchers } = await import("./refresh.js");
      await closeSkillsWatchers(true);
      vi.restoreAllMocks();
      cleanup();
    }),
  );

  it("shares ancestor observation while preserving root appearance and remaining subscriptions", async () => {
    const root = await fs.realpath(roots.make("skills-shared-ancestor-"));
    const source = (name: string) => {
      const sourceRoot = path.join(root, name, "nested", "skills");
      return {
        workspaceDir: path.join(root, `workspace-${name}`),
        sourceRoot,
        config: { skills: { load: { extraDirs: [sourceRoot] } } },
      };
    };
    const first = source("left");
    const second = source("right");
    for (const current of [first, second]) {
      await fs.mkdir(path.join(current.workspaceDir, "skills"), { recursive: true });
    }
    const watch = vi.spyOn(chokidar, "watch");
    const { ensureSkillsWatcher, registerSkillsChangeListener } = await import("./refresh.js");
    const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
    for (const current of [first, second]) {
      ensureSkillsWatcher(current);
    }
    await Promise.all(
      watch.mock.results.map((result) => {
        if (result.type !== "return") {
          throw new Error("Watcher acquisition failed");
        }
        return new Promise<void>((resolve, reject) => {
          result.value.once("ready", resolve);
          result.value.once("error", reject);
        });
      }),
    );
    expect(watch.mock.calls.filter(([watched]) => watched === root)).toHaveLength(1);
    const changes: string[] = [];
    const unregister = registerSkillsChangeListener((event) => {
      if (event.workspaceDir) {
        changes.push(event.workspaceDir);
      }
    });
    const read = (current: typeof first) =>
      loadWorkspaceSkills(current.workspaceDir, {
        config: current.config,
        bundledSkillsDir: "",
        managedSkillsDir: path.join(root, "unused"),
      }).map((entry) => entry.skill.name);
    const writeSkill = async (current: typeof first, name: string) => {
      const directory = path.join(current.sourceRoot, name);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: Shared ancestor proof\n---\n`,
      );
    };
    try {
      expect(read(first)).toEqual([]);
      expect(read(second)).toEqual([]);
      await fs.writeFile(path.join(root, "unrelated.sqlite-wal"), "unrelated");
      await writeSkill(first, "first-proof");
      await expect.poll(() => read(first), { timeout: 3_000 }).toContain("first-proof");
      expect(changes).not.toContain(second.workspaceDir);
      const relocated = path.join(root, "left-away");
      await fs.rename(path.join(root, "left"), relocated);
      await expect.poll(() => read(first), { timeout: 3_000 }).toEqual([]);
      // Retiring one logical workspace must not retire the shared missing-root observer.
      ensureSkillsWatcher({
        workspaceDir: first.workspaceDir,
        config: { skills: { load: { watch: false } } },
      });
      await writeSkill(second, "remaining-proof");
      await expect.poll(() => read(second), { timeout: 3_000 }).toContain("remaining-proof");
      await fs.rm(path.join(root, "right"), { recursive: true });
      await expect.poll(() => read(second), { timeout: 3_000 }).toEqual([]);
      await writeSkill(second, "recreated-proof");
      await expect.poll(() => read(second), { timeout: 3_000 }).toContain("recreated-proof");
    } finally {
      unregister();
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not promote missing roots through newly created ancestor symlinks",
    async () => {
      const root = await fs.realpath(roots.make("skills-ancestor-symlink-"));
      const outside = await fs.realpath(roots.make("skills-ancestor-outside-"));
      const workspaceDir = path.join(root, "workspace");
      await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
      const link = path.join(root, "missing");
      const sourceRoot = path.join(link, "nested", "skills");
      await fs.mkdir(path.join(outside, "nested", "skills", "outside-proof"), { recursive: true });
      const config = { skills: { load: { extraDirs: [sourceRoot] } } };
      const watch = vi.spyOn(chokidar, "watch");
      const { ensureSkillsWatcher } = await import("./refresh.js");
      const { getSkillsSourceVersion } = await import("./refresh-state.js");
      const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
      const read = () =>
        loadWorkspaceSkills(workspaceDir, {
          config,
          bundledSkillsDir: "",
          managedSkillsDir: path.join(root, "unused"),
        }).map((entry) => entry.skill.name);
      ensureSkillsWatcher({ workspaceDir, config });
      expect(read()).toEqual([]);
      await Promise.all(
        watch.mock.results.map((result) => {
          if (result.type !== "return") {
            throw new Error("Watcher acquisition failed");
          }
          return new Promise<void>((resolve, reject) => {
            result.value.once("ready", resolve);
            result.value.once("error", reject);
          });
        }),
      );
      // Ready handlers reconcile synchronously before these promises resolve.
      // Unchanged empty inventory suppresses public events, but discovery still invalidates.
      const sourceVersion = getSkillsSourceVersion(workspaceDir);
      await fs.symlink(outside, link, "dir");
      await expect
        .poll(() => getSkillsSourceVersion(workspaceDir), { timeout: 3_000 })
        .toBeGreaterThan(sourceVersion);
      expect(
        watch.mock.calls.some(
          ([watched]) =>
            typeof watched === "string" && (watched === link || watched.startsWith(`${link}/`)),
        ),
      ).toBe(false);
      await fs.unlink(link);
      const skillDir = path.join(sourceRoot, "ordinary-proof");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: ordinary-proof\ndescription: Ordinary replacement\n---\n",
      );
      await expect.poll(read, { timeout: 3_000 }).toContain("ordinary-proof");
    },
  );
});
