import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../../state/openclaw-state-db.js";
import {
  withLocalWorkspaceProjection,
  type LocalWorkspaceOwner,
} from "./local-workspace-projection.js";
import { localWorkspaceStore } from "./local-workspace-store.js";

let root: string;
let owner: LocalWorkspaceOwner;
let revoked = false;
const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-projection-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
  vi.stubEnv("GIT_CONFIG_SYSTEM", os.devNull);
  const repo = path.join(root, "source");
  const checkout = path.join(root, "canonical");
  await fs.mkdir(repo);
  await git(repo, "init", "--quiet", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.invalid");
  await fs.writeFile(path.join(repo, "source.txt"), "original\n");
  await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "--quiet", "-m", "base");
  await git(repo, "worktree", "add", "--quiet", "-b", "openclaw/guest", checkout);
  await fs.writeFile(path.join(checkout, ".env.local"), "host-only-secret");
  await git(repo, "config", "credential.helper", "!echo host-credential");
  revoked = false;
  const sessionKey = `agent:main:dashboard:guest-${randomUUID()}`;
  owner = {
    agentId: "main",
    sessionKey,
    sessionId: randomUUID(),
    lifecycleRevision: null,
    assertCurrent: () => {
      if (revoked) {
        throw new Error("revoked");
      }
    },
    worktree: {
      id: randomUUID(),
      name: "guest",
      repoFingerprint: "test",
      repoRoot: repo,
      path: checkout,
      branch: "openclaw/guest",
      baseRef: "main",
      ownerKind: "session",
      ownerId: sessionKey,
      createdAt: 0,
      lastActiveAt: 0,
    },
  };
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("local sandbox workspace reconciliation", () => {
  it.runIf(process.env.OPENCLAW_TEST_LOCAL_PROJECTION_PODMAN === "1")(
    "edits and runs Git in a real required Podman sandbox across turns",
    async () => {
      const [
        { insertRegistryWorktree },
        { upsertSessionEntryCore },
        { resolveSandboxContext },
        { removeSandboxContainer },
        { readRegistry },
        { runCommandWithTimeout },
      ] = await Promise.all([
        import("../../agents/worktrees/registry.js"),
        import("../../config/sessions/session-accessor.js"),
        import("../../agents/sandbox/context.js"),
        import("../../agents/sandbox/manage.js"),
        import("../../agents/sandbox/registry.js"),
        import("../../process/exec.js"),
      ]);
      const engineHome = process.env.OPENCLAW_TEST_PODMAN_HOME;
      const engineRuntime = process.env.OPENCLAW_TEST_PODMAN_RUNTIME_DIR;
      if (!engineHome || !engineRuntime) {
        throw new Error("Real Podman proof requires explicit engine HOME and runtime directory");
      }
      vi.stubEnv("HOME", engineHome);
      vi.stubEnv("XDG_CONFIG_HOME", path.join(engineHome, ".config"));
      vi.stubEnv("XDG_DATA_HOME", path.join(engineHome, ".local", "share"));
      vi.stubEnv("XDG_RUNTIME_DIR", engineRuntime);
      const { ManagedWorktreeService, SNAPSHOT_RETENTION_MS } =
        await import("../../agents/worktrees/service.js");
      const { captureGitHubPublicationWorkspaceSnapshot } =
        await import("../github-publication-git-transport.js");
      let now = Date.now();
      const service = new ManagedWorktreeService({ now: () => now });
      owner.worktree.repoFingerprint = (
        await service.resolveRepositoryIdentity(owner.worktree.path)
      ).fingerprint;
      insertRegistryWorktree(process.env, owner.worktree, { provisionedPaths: [] });
      await upsertSessionEntryCore(
        { agentId: owner.agentId, sessionKey: owner.sessionKey },
        {
          sessionId: owner.sessionId,
          updatedAt: Date.now(),
          sandbox: "required",
          spawnedCwd: owner.worktree.path,
          sessionRoot: owner.worktree.path,
          worktree: {
            id: owner.worktree.id,
            branch: owner.worktree.branch,
            repoRoot: owner.worktree.repoRoot,
            canonicalWorkspaceDir: owner.worktree.repoRoot,
          },
        },
      );
      const workspace = path.join(root, "agent");
      await fs.mkdir(workspace);
      const config: import("../../config/types.openclaw.js").OpenClawConfig = {
        agents: {
          entries: { main: { workspace } },
          defaults: {
            skipBootstrap: true,
            sandbox: {
              mode: "off",
              backend: "podman",
              scope: "session",
              workspaceAccess: "none",
              prune: { idleHours: 0, maxAgeDays: 0 },
              docker: { image: "localhost/openclaw-sandbox:bookworm-slim", network: "none" },
            },
          },
        },
      };
      try {
        const sandbox = await resolveSandboxContext({
          config,
          agentId: owner.agentId,
          sessionKey: owner.sessionKey,
          workspaceDir: owner.worktree.path,
        });
        expect(sandbox?.required).toBe(true);
        expect(sandbox?.workspaceAccess).toBe("rw");
        if (!sandbox?.backend || !sandbox.fsBridge) {
          throw new Error("Sandbox was not prepared");
        }
        const skillScaffold = path.join(sandbox.workspaceDir, ".openclaw/sandbox-skills/skills");
        expect((await fs.stat(skillScaffold)).uid).toBe((await fs.stat(sandbox.workspaceDir)).uid);
        await sandbox.fsBridge.writeFile({ filePath: "source.txt", data: "real sandbox edit\n" });
        await sandbox.fsBridge.writeFile({
          filePath: ".gitignore",
          data: ".env.local\nguest-ignored/\n",
        });
        await sandbox.fsBridge.writeFile({
          filePath: "guest-ignored/data",
          data: "real ignored guest bytes\n",
        });
        await sandbox.fsBridge.writeFile({
          filePath: ".openclaw/project.json",
          data: "valid project content\n",
        });
        await expect(
          sandbox.fsBridge.writeFile({
            filePath: ".openclaw/sandbox-skills/skills/forbidden",
            data: "must not write",
          }),
        ).rejects.toThrow();
        expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
          "real sandbox edit\n",
        );
        const spec = await sandbox.backend.buildExecSpec({
          command:
            'git status --porcelain && test ! -e .env.local && test -z "$GH_TOKEN$GITHUB_TOKEN" && ! touch .openclaw/sandbox-skills/skills/.write-probe',
          usePty: false,
          env: {},
        });
        const result = await runCommandWithTimeout(spec.argv, {
          baseEnv: spec.env,
          timeoutMs: 30000,
        });
        await sandbox.backend.finalizeExec?.({
          status: result.code === 0 ? "completed" : "failed",
          exitCode: result.code,
          timedOut: false,
          token: spec.finalizeToken,
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("source.txt");
        const resumed = await resolveSandboxContext({
          config,
          agentId: owner.agentId,
          sessionKey: owner.sessionKey,
          workspaceDir: owner.worktree.path,
        });
        expect(resumed?.workspaceDir).toBe(sandbox.workspaceDir);
        expect((await resumed!.fsBridge!.readFile({ filePath: "source.txt" })).toString()).toBe(
          "real sandbox edit\n",
        );
        expect(await fs.readFile(path.join(owner.worktree.repoRoot, "source.txt"), "utf8")).toBe(
          "original\n",
        );
        // The source-only fixture deliberately installed an unsafe host helper.
        // Publication must reject it, then succeed only after the fixture owner removes it.
        await expect(
          captureGitHubPublicationWorkspaceSnapshot({ cwd: owner.worktree.path }),
        ).rejects.toThrow("unsupported Git transport");
        await git(owner.worktree.repoRoot, "config", "--unset-all", "credential.helper");
        const published = await captureGitHubPublicationWorkspaceSnapshot({
          cwd: owner.worktree.path,
          assertCurrent: owner.assertCurrent,
        });
        const publishedPaths = await git(
          owner.worktree.path,
          "ls-tree",
          "-r",
          "--name-only",
          published.workspaceTree,
        );
        expect(publishedPaths).toContain(".openclaw/project.json");
        expect(publishedPaths).not.toContain("sandbox-skills");
        expect(publishedPaths).not.toContain("guest-ignored");
        expect(
          await git(owner.worktree.path, "show", `${published.workspaceTree}:source.txt`),
        ).toBe("real sandbox edit");
        const removed = await service.remove({
          id: owner.worktree.id,
          reason: "live-proof-archive",
        });
        expect(removed.removed).toBe(true);
        expect((await readRegistry()).entries).toEqual([]);
        await service.restore({ id: owner.worktree.id });
        expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
          "real sandbox edit\n",
        );
        expect(
          await fs.readFile(path.join(owner.worktree.path, ".openclaw/project.json"), "utf8"),
        ).toBe("valid project content\n");
        const restored = await resolveSandboxContext({
          config,
          agentId: owner.agentId,
          sessionKey: owner.sessionKey,
          workspaceDir: owner.worktree.path,
        });
        expect(restored?.workspaceDir).toBe(sandbox.workspaceDir);
        expect(
          (await restored!.fsBridge!.readFile({ filePath: "guest-ignored/data" })).toString(),
        ).toBe("real ignored guest bytes\n");
        expect(
          await fs.readFile(path.join(owner.worktree.path, "guest-ignored/data"), "utf8"),
        ).toBe("real ignored guest bytes\n");
        await expect(
          fs.stat(path.join(restored!.workspaceDir, ".env.local")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect((await restored!.fsBridge!.readFile({ filePath: "source.txt" })).toString()).toBe(
          "real sandbox edit\n",
        );
        expect(
          (await service.remove({ id: owner.worktree.id, reason: "live-proof-retention" })).removed,
        ).toBe(true);
        now += SNAPSHOT_RETENTION_MS + 1;
        expect((await service.gc()).snapshotsPruned).toBe(1);
        expect(localWorkspaceStore().get(owner.worktree.id)).toBeUndefined();
        await expect(fs.stat(sandbox.workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        for (const runtime of (await readRegistry()).entries) {
          await removeSandboxContainer(runtime.containerName);
        }
      }
    },
    120000,
  );

  it("installs additive owner state without changing the database version", async () => {
    const [
      { openOpenClawStateDatabase },
      { tableExists },
      { OPENCLAW_STATE_SCHEMA_SQL },
      { FIRST_USE_STATE_TABLES },
      { extractSqliteTableSchema },
      { assertSqliteSchemaContains },
    ] = await Promise.all([
      import("../../state/openclaw-state-db.js"),
      import("../../state/openclaw-state-db-schema-helpers.js"),
      import("../../state/openclaw-state-schema.js"),
      import("../../state/openclaw-state-db-contract.js"),
      import("../../infra/sqlite-schema-sql.js"),
      import("../../infra/sqlite-schema-contract.js"),
    ]);
    const db = openOpenClawStateDatabase().db;
    const version = db
      .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
      .get();
    expect(tableExists(db, "local_workspace_projections")).toBe(false);
    await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect(
      db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual(version);
    const priorSchema = OPENCLAW_STATE_SCHEMA_SQL.replace(
      extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "local_workspace_projections"),
      "",
    );
    expect(() =>
      assertSqliteSchemaContains(db, "prior schema", priorSchema, {
        allowedMissingTables: FIRST_USE_STATE_TABLES,
      }),
    ).not.toThrow();
    await closeOpenClawStateDatabaseAsync();
    expect(localWorkspaceStore().get(owner.worktree.id)?.session_id).toBe(owner.sessionId);
  });

  it("seeds independent source-only Git and reconciles edits without host metadata or ignored secrets", async () => {
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect(await fs.readFile(path.join(projection, "source.txt"), "utf8")).toBe("original\n");
    expect((await fs.lstat(path.join(projection, ".git"))).isDirectory()).toBe(true);
    expect(await git(projection, "rev-parse", "--git-common-dir")).toBe(".git");
    await expect(fs.stat(path.join(projection, ".env.local"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(projection, ".git", "config"), "utf8")).not.toContain(
      "credential",
    );
    await expect(
      fs.stat(path.join(projection, ".git", "objects", "info", "alternates")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(path.join(projection, "source.txt"), "guest edit\n");
    await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
    expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
      "guest edit\n",
    );
    expect(await fs.readFile(path.join(owner.worktree.repoRoot, "source.txt"), "utf8")).toBe(
      "original\n",
    );
    expect(await withLocalWorkspaceProjection(owner, (state) => state.prepare())).toBe(projection);
    expect(await git(projection, "status", "--porcelain")).toContain("source.txt");
  });

  it.each(["root", "nested"])(
    "never admits host secrets after guest de-ignore: %s",
    async (scope) => {
      const prefix = scope === "nested" ? "nested/" : "";
      await fs.mkdir(path.join(owner.worktree.path, prefix), { recursive: true });
      const ignore = prefix + ".gitignore";
      await fs.writeFile(path.join(owner.worktree.path, ignore), ".env.local\n.env.later\n");
      await fs.writeFile(
        path.join(owner.worktree.path, prefix + ".env.local"),
        "synthetic host secret",
      );
      const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      await fs.writeFile(path.join(projection, ignore), "");
      await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
      await fs.writeFile(
        path.join(owner.worktree.path, prefix + ".env.later"),
        "new synthetic provisioning",
      );
      await closeOpenClawStateDatabaseAsync();
      await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      for (const name of [".env.local", ".env.later"]) {
        await expect(fs.stat(path.join(projection, prefix + name))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
  );

  it.each(["publication", "archive"])(
    "keeps de-ignored host bytes outside %s admission",
    async (operation) => {
      const [
        { insertRegistryWorktree },
        { ManagedWorktreeService },
        { captureGitHubPublicationWorkspaceSnapshot },
      ] = await Promise.all([
        import("../../agents/worktrees/registry.js"),
        import("../../agents/worktrees/service.js"),
        import("../github-publication-git-transport.js"),
      ]);
      const service = new ManagedWorktreeService();
      owner.worktree.repoFingerprint = (
        await service.resolveRepositoryIdentity(owner.worktree.path)
      ).fingerprint;
      insertRegistryWorktree(process.env, owner.worktree, { provisionedPaths: [] });
      await git(owner.worktree.repoRoot, "config", "--unset-all", "credential.helper");
      const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      await fs.writeFile(path.join(projection, ".gitignore"), "");
      await fs.writeFile(path.join(projection, "guest-new.txt"), "guest source");
      await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
      let tree: string;
      if (operation === "publication") {
        tree = (await captureGitHubPublicationWorkspaceSnapshot({ cwd: owner.worktree.path }))
          .workspaceTree;
      } else {
        const removed = await service.remove({
          id: owner.worktree.id,
          reason: "de-ignore archive",
        });
        tree = removed.snapshotRef!;
        await service.restore({ id: owner.worktree.id });
        await closeOpenClawStateDatabaseAsync();
        // Canonical archives retain host data, but restoring it is not guest admission.
        expect(await fs.readFile(path.join(owner.worktree.path, ".env.local"), "utf8")).toBe(
          "host-only-secret",
        );
        await withLocalWorkspaceProjection(owner, (state) => state.prepare());
        await expect(fs.stat(path.join(projection, ".env.local"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      const paths = await git(owner.worktree.repoRoot, "ls-tree", "-r", "--name-only", tree);
      if (operation === "publication") {
        expect(paths).not.toContain(".env.local");
      } else {
        expect(paths).toContain(".env.local");
        const publication = await captureGitHubPublicationWorkspaceSnapshot({
          cwd: owner.worktree.path,
        });
        expect(
          await git(
            owner.worktree.repoRoot,
            "ls-tree",
            "-r",
            "--name-only",
            publication.workspaceTree,
          ),
        ).not.toContain(".env.local");
      }
      expect(paths).toContain("guest-new.txt");
    },
  );

  it.skipIf(process.platform === "win32").each(["initial", "later index"])(
    "rejects non-UTF-8 path aliases before guest capture: %s",
    async (when) => {
      const ignored = "private-\uFFFD";
      await fs.writeFile(path.join(owner.worktree.path, ".gitignore"), ignored + "\n");
      await fs.writeFile(path.join(owner.worktree.path, ignored), "synthetic ignored host secret");
      if (when === "later index") {
        await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      }
      const raw = Buffer.concat([
        Buffer.from(owner.worktree.path + "/private-"),
        Buffer.from([0xff]),
      ]);
      await fs.writeFile(raw, "ordinary source with an invalid filename");
      if (when === "later index") {
        await git(owner.worktree.path, "add", "-A");
      }
      await expect(withLocalWorkspaceProjection(owner, (state) => state.prepare())).rejects.toThrow(
        "UTF-8",
      );
    },
  );

  it("admits exact canonical source and host-staged new paths without trusting guest Git", async () => {
    await fs.writeFile(path.join(owner.worktree.path, "initial.txt"), "initial untracked source");
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect(await fs.readFile(path.join(projection, "initial.txt"), "utf8")).toBe(
      "initial untracked source",
    );
    await fs.writeFile(path.join(owner.worktree.path, "initial.txt"), "later canonical edit");
    await fs.writeFile(path.join(owner.worktree.path, "new.txt"), "new canonical source");
    await fs.writeFile(path.join(owner.worktree.path, ".env.new"), "new host-only provisioning");
    await fs.writeFile(path.join(projection, ".gitignore"), "*.ignored\n");
    await fs.writeFile(path.join(projection, "guest.ignored"), "guest-owned ignored bytes");
    await fs.writeFile(path.join(projection, ".env.new"), "guest collision");
    await git(projection, "add", ".env.new");
    await expect(
      withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical")),
    ).rejects.toThrow("conflict");
    // The conflict owner preserves both versions. Resolve this fixture by restoring
    // the guest's captured base, not by enrolling the host's colliding bytes.
    await fs.rm(path.join(owner.worktree.path, ".env.new"));
    await withLocalWorkspaceProjection(owner, (state) => state.settle());
    await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect(await fs.readFile(path.join(projection, "initial.txt"), "utf8")).toBe(
      "later canonical edit",
    );
    await expect(fs.stat(path.join(projection, "new.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await git(owner.worktree.path, "add", "new.txt");
    await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect(await fs.readFile(path.join(projection, "new.txt"), "utf8")).toBe(
      "new canonical source",
    );
    expect(await fs.readFile(path.join(projection, "guest.ignored"), "utf8")).toBe(
      "guest-owned ignored bytes",
    );
  });

  it.skipIf(process.platform === "win32")(
    "never executes source repository helpers while seeding missing objects",
    async () => {
      const blob = await git(owner.worktree.path, "rev-parse", "HEAD:source.txt");
      const object = path.join(
        owner.worktree.repoRoot,
        ".git/objects",
        blob.slice(0, 2),
        blob.slice(2),
      );
      const bytes = await fs.readFile(object);
      const helper = path.join(root, "ssh-probe");
      await fs.writeFile(helper, '#!/bin/sh\nprintf invoked > "$0.ran"\nexit 1\n', { mode: 0o700 });
      await git(
        owner.worktree.repoRoot,
        "config",
        "remote.origin.url",
        "ssh://fixture.invalid/repository",
      );
      await git(owner.worktree.repoRoot, "config", "remote.origin.promisor", "true");
      await git(owner.worktree.repoRoot, "config", "core.sshCommand", helper);
      await fs.rm(object);
      await expect(
        withLocalWorkspaceProjection(owner, (state) => state.prepare()),
      ).rejects.toThrow();
      expect(existsSync(helper + ".ran")).toBe(false);
      await fs.writeFile(object, bytes);
      const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      expect(await fs.readFile(path.join(projection, "source.txt"), "utf8")).toBe("original\n");
      expect(existsSync(helper + ".ran")).toBe(false);
    },
  );

  it("imports canonical edits on the second turn without copying newly provisioned secrets", async () => {
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    await fs.writeFile(path.join(owner.worktree.path, "source.txt"), "human edit\n");
    await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect(await fs.readFile(path.join(projection, "source.txt"), "utf8")).toBe("human edit\n");
    await expect(fs.stat(path.join(projection, ".env.local"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("seeds a committed nested source tree with a complete manifest namespace", async () => {
    await fs.mkdir(path.join(owner.worktree.path, "src/lib"), { recursive: true });
    await fs.writeFile(path.join(owner.worktree.path, "src/lib/source.ts"), "nested seed");
    await git(owner.worktree.path, "add", "src/lib/source.ts");
    await git(owner.worktree.path, "commit", "--quiet", "-m", "nested seed");
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect(await fs.readFile(path.join(projection, "src/lib/source.ts"), "utf8")).toBe(
      "nested seed",
    );
    await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  });

  it("keeps eligible nested project content and accepted empty directories across turns", async () => {
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    await fs.mkdir(path.join(projection, ".openclaw/sandbox-skills/skills"), { recursive: true });
    await fs.mkdir(path.join(projection, "src/empty"), { recursive: true });
    await fs.writeFile(path.join(projection, ".openclaw/project.json"), "project content");
    await fs.writeFile(path.join(projection, "src/nested.ts"), "nested content");
    await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
    await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect(await fs.readFile(path.join(projection, ".openclaw/project.json"), "utf8")).toBe(
      "project content",
    );
    expect(await fs.readFile(path.join(projection, "src/nested.ts"), "utf8")).toBe(
      "nested content",
    );
    expect((await fs.stat(path.join(projection, "src/empty"))).isDirectory()).toBe(true);
    await expect(
      fs.stat(path.join(owner.worktree.path, ".openclaw/sandbox-skills")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains both sides and a durable pending result when edits conflict", async () => {
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    await fs.writeFile(path.join(projection, "source.txt"), "guest conflict\n");
    await fs.writeFile(path.join(owner.worktree.path, "source.txt"), "human conflict\n");
    await expect(
      withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical")),
    ).rejects.toThrow("conflict");
    expect(localWorkspaceStore().get(owner.worktree.id)?.pending_ref).toBeTruthy();
    expect(await fs.readFile(path.join(projection, "source.txt"), "utf8")).toBe("guest conflict\n");
    expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
      "human conflict\n",
    );
    await fs.writeFile(path.join(owner.worktree.path, "source.txt"), "original\n");
    await withLocalWorkspaceProjection(owner, (state) => state.settle());
    expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
      "guest conflict\n",
    );
    expect(localWorkspaceStore().get(owner.worktree.id)?.pending_ref).toBeNull();
  });

  it("recovers the persisted rollback journal after authority closes during acceptance", async () => {
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    await fs.writeFile(path.join(projection, "source.txt"), "interrupted guest edit\n");
    const interrupted = {
      ...owner,
      assertCurrent: () => {
        if (
          readFileSync(path.join(owner.worktree.path, "source.txt"), "utf8") ===
          "interrupted guest edit\n"
        ) {
          revoked = true;
        }
        owner.assertCurrent();
      },
    };
    await expect(
      withLocalWorkspaceProjection(interrupted, (state) => state.synchronize("canonical")),
    ).rejects.toThrow();
    expect(localWorkspaceStore().get(owner.worktree.id)?.journal_json).toBeTruthy();
    expect(localWorkspaceStore().get(owner.worktree.id)?.pending_ref).toBeTruthy();
    revoked = false;
    closeOpenClawStateDatabase();
    await withLocalWorkspaceProjection(owner, (state) => state.settle());
    expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
      "interrupted guest edit\n",
    );
    expect(localWorkspaceStore().get(owner.worktree.id)).toMatchObject({
      journal_json: null,
      pending_ref: null,
    });
  });

  it("recovers accepted-result cleanup without replaying an already accepted edit", async () => {
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    await fs.writeFile(path.join(projection, "source.txt"), "accepted guest edit\n");
    const interrupted = {
      ...owner,
      assertCurrent: () => {
        const row = localWorkspaceStore().get(owner.worktree.id);
        if (row?.pending_ref && row.pending_target === null) {
          revoked = true;
        }
        owner.assertCurrent();
      },
    };
    await expect(
      withLocalWorkspaceProjection(interrupted, (state) => state.synchronize("canonical")),
    ).rejects.toThrow("revoked");
    expect(localWorkspaceStore().get(owner.worktree.id)).toMatchObject({
      pending_ref: expect.any(String),
      pending_target: null,
      journal_json: null,
    });
    await fs.writeFile(path.join(owner.worktree.path, "source.txt"), "later human edit\n");
    revoked = false;
    closeOpenClawStateDatabase();
    await withLocalWorkspaceProjection(owner, (state) => state.settle());
    expect(localWorkspaceStore().get(owner.worktree.id)?.pending_ref).toBeNull();
    expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
      "later human edit\n",
    );
  });

  it("settles edits before managed snapshot removal and preserves them after restore", async () => {
    const [{ insertRegistryWorktree }, { ManagedWorktreeService }] = await Promise.all([
      import("../../agents/worktrees/registry.js"),
      import("../../agents/worktrees/service.js"),
    ]);
    const service = new ManagedWorktreeService();
    const identity = await service.resolveRepositoryIdentity(owner.worktree.path);
    owner.worktree.repoFingerprint = identity.fingerprint;
    insertRegistryWorktree(process.env, owner.worktree, { provisionedPaths: [] });
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    await fs.writeFile(path.join(projection, "source.txt"), "retained guest edit\n");
    const removed = await service.remove({ id: owner.worktree.id, reason: "test-archive" });
    expect(removed.removed).toBe(true);
    expect(removed.snapshotRef).toBeTruthy();
    await service.restore({ id: owner.worktree.id });
    expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
      "retained guest edit\n",
    );
    expect(await withLocalWorkspaceProjection(owner, (state) => state.prepare())).toBe(projection);
  });

  it.each(["current", "legacy decoder", "failed restore retry", "retention"] as const)(
    "preserves accepted ignored files, symlinks and empty directories through archive: %s",
    async (mode) => {
      const [
        {
          insertRegistryWorktree,
          getRegistryWorktree,
          getRegistryWorktreeProvisionedState,
          updateRegistryWorktree,
        },
        { ManagedWorktreeService, SNAPSHOT_RETENTION_MS },
        { restoreProvisionedFiles },
      ] = await Promise.all([
        import("../../agents/worktrees/registry.js"),
        import("../../agents/worktrees/service.js"),
        import("../../agents/worktrees/provisioned-files.js"),
      ]);
      let now = Date.now();
      const service = new ManagedWorktreeService({ now: () => now });
      owner.worktree.repoFingerprint = (
        await service.resolveRepositoryIdentity(owner.worktree.path)
      ).fingerprint;
      insertRegistryWorktree(process.env, owner.worktree, { provisionedPaths: [".env.allowed"] });
      await fs.writeFile(
        path.join(owner.worktree.path, ".env.allowed"),
        "original provisioned bytes",
      );
      await fs.chmod(path.join(owner.worktree.path, ".env.allowed"), 0o600);
      await fs.writeFile(
        path.join(owner.worktree.path, ".gitignore"),
        ".env.local\n.env.allowed\nguest-ignored/\n",
      );
      await fs.mkdir(path.join(owner.worktree.path, "guest-ignored"));
      await fs.writeFile(
        path.join(owner.worktree.path, "guest-ignored/host-secret"),
        "not guest custody",
      );
      const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      await fs.mkdir(path.join(projection, "guest-ignored/empty"), { recursive: true });
      const bytes = Buffer.from("guest-owned ignored bytes\0\n");
      await fs.writeFile(path.join(projection, "guest-ignored/data"), bytes);
      if (process.platform !== "win32") {
        await fs.symlink("../source.txt", path.join(projection, "guest-ignored/link"));
      }
      await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
      expect(await fs.readFile(path.join(owner.worktree.path, "guest-ignored/data"))).toEqual(
        bytes,
      );
      const removed = await service.remove({
        id: owner.worktree.id,
        reason: "accepted-ignored-archive",
      });
      expect(removed.removed).toBe(true);
      expect(
        await git(owner.worktree.repoRoot, "ls-tree", "-r", "--name-only", removed.snapshotRef!),
      ).not.toContain("guest-ignored");
      const receipt = localWorkspaceStore().get(owner.worktree.id)!.pending_ref!;
      expect(receipt).toBeTruthy();
      const legacyState = getRegistryWorktreeProvisionedState(process.env, owner.worktree.id)!;
      expect(legacyState).toEqual([{ path: ".env.allowed", mode: expect.any(Number), chunks: 1 }]);
      await closeOpenClawStateDatabaseAsync();
      if (mode === "retention") {
        now += SNAPSHOT_RETENTION_MS + 1;
        await fs.writeFile(path.join(projection, "guest-ignored/data"), "unaccepted newer bytes");
        expect((await service.gc()).snapshotsPruned).toBe(0);
        expect(
          await git(owner.worktree.repoRoot, "rev-parse", "--verify", removed.snapshotRef!),
        ).toMatch(/^[a-f0-9]+$/u);
        await fs.writeFile(path.join(projection, "guest-ignored/data"), bytes);
        expect((await service.gc()).snapshotsPruned).toBe(1);
        expect(localWorkspaceStore().get(owner.worktree.id)).toBeUndefined();
        expect(getRegistryWorktree(process.env, owner.worktree.id)).toBeUndefined();
        expect(
          await git(
            owner.worktree.repoRoot,
            "for-each-ref",
            "--format=%(refname)",
            receipt,
            removed.snapshotRef!,
          ),
        ).toBe("");
        await expect(fs.stat(projection)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      if (mode === "legacy decoder") {
        // Execute the pre-feature restore sequence and unchanged old decoder, not
        // just its schema preflight. The ledger contains only original regular files.
        const snapshot = await git(owner.worktree.repoRoot, "rev-parse", removed.snapshotRef!);
        const parent = await git(owner.worktree.repoRoot, "rev-parse", snapshot + "^");
        await git(
          owner.worktree.repoRoot,
          "worktree",
          "add",
          "--no-checkout",
          "-b",
          owner.worktree.branch,
          owner.worktree.path,
          parent,
        );
        await git(
          owner.worktree.path,
          "read-tree",
          "--reset",
          "--no-recurse-submodules",
          "-u",
          snapshot,
        );
        await git(owner.worktree.path, "reset", "--quiet", parent);
        await restoreProvisionedFiles(
          process.env,
          owner.worktree.id,
          owner.worktree.path,
          legacyState,
        );
        expect(await fs.readFile(path.join(owner.worktree.path, ".env.allowed"), "utf8")).toBe(
          "original provisioned bytes",
        );
        expect(existsSync(path.join(owner.worktree.path, "guest-ignored/data"))).toBe(false);
        updateRegistryWorktree(process.env, owner.worktree.id, {
          removedAt: undefined,
          lastActiveAt: now + 1,
          provisionedPaths: legacyState.map((entry) => entry.path),
        });
        await closeOpenClawStateDatabaseAsync();
      } else {
        if (mode === "failed restore retry") {
          let injected = false;
          await expect(
            service.restore({
              id: owner.worktree.id,
              commitGuard: () => {
                const row = localWorkspaceStore().get(owner.worktree.id);
                if (
                  !injected &&
                  row?.pending_ref &&
                  row.pending_target === null &&
                  existsSync(path.join(owner.worktree.path, "guest-ignored/data"))
                ) {
                  injected = true;
                  throw new Error("restore interrupted after overlay acceptance");
                }
              },
            }),
          ).rejects.toThrow("restore interrupted after overlay acceptance");
          expect(injected).toBe(true);
          expect(existsSync(owner.worktree.path)).toBe(false);
          expect(localWorkspaceStore().get(owner.worktree.id)?.pending_ref).toBe(receipt);
          expect(getRegistryWorktree(process.env, owner.worktree.id)?.removedAt).toBeDefined();
        }
        await service.restore({ id: owner.worktree.id });
      }
      await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      for (const workspace of [owner.worktree.path, projection]) {
        expect(await fs.readFile(path.join(workspace, "guest-ignored/data"))).toEqual(bytes);
        expect((await fs.stat(path.join(workspace, "guest-ignored/empty"))).isDirectory()).toBe(
          true,
        );
        if (process.platform !== "win32") {
          expect(await fs.readlink(path.join(workspace, "guest-ignored/link"))).toBe(
            "../source.txt",
          );
        }
        await expect(
          fs.stat(path.join(workspace, "guest-ignored/host-secret")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(path.join(workspace, ".env.local"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      expect(await fs.readFile(path.join(owner.worktree.path, ".env.allowed"), "utf8")).toBe(
        "original provisioned bytes",
      );
      await expect(fs.stat(path.join(projection, ".env.allowed"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(localWorkspaceStore().get(owner.worktree.id)?.pending_ref).toBeNull();
      await git(owner.worktree.repoRoot, "config", "--unset-all", "credential.helper");
      const { captureGitHubPublicationWorkspaceSnapshot } =
        await import("../github-publication-git-transport.js");
      const published = await captureGitHubPublicationWorkspaceSnapshot({
        cwd: owner.worktree.path,
      });
      expect(
        await git(owner.worktree.path, "ls-tree", "-r", "--name-only", published.workspaceTree),
      ).not.toContain("guest-ignored");
    },
  );

  it("retains pending bytes across a same-conversation lifecycle reset", async () => {
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    await fs.writeFile(path.join(projection, "source.txt"), "before reset\n");
    const resumed = { ...owner, lifecycleRevision: randomUUID() };
    expect(await withLocalWorkspaceProjection(resumed, (state) => state.prepare())).toBe(
      projection,
    );
    expect(await fs.readFile(path.join(owner.worktree.path, "source.txt"), "utf8")).toBe(
      "before reset\n",
    );
    expect(localWorkspaceStore().get(owner.worktree.id)?.lifecycle_revision).toBe(
      resumed.lifecycleRevision,
    );
  });

  it("does not let a replacement session adopt the old projection", async () => {
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    await fs.writeFile(path.join(projection, "source.txt"), "unaccepted edit\n");
    await expect(
      withLocalWorkspaceProjection({ ...owner, sessionId: randomUUID() }, (state) =>
        state.prepare(),
      ),
    ).rejects.toThrow("different session incarnation");
    expect(await fs.readFile(path.join(projection, "source.txt"), "utf8")).toBe(
      "unaccepted edit\n",
    );
    revoked = true;
    await expect(withLocalWorkspaceProjection(owner, (state) => state.prepare())).rejects.toThrow(
      "revoked",
    );
  });
});
