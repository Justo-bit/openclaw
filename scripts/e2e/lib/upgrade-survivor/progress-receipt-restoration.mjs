// The survivor runner owns installation, the original update driver, and backup/restore.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  assertWorkerCellPackageIdentity,
  readWorkerCellPackageIdentity,
  resolveWorkerCellExport,
  resolveWorkerCellFunctionBinding,
} from "./worker-cell-package.mjs";

const BASELINE_COMMIT = "3a9d69db306cd7f081e06254cb89c4bcc14a7107";
const AGENT = "main";
const SESSION_KEY = "agent:main:dashboard:progress-receipt-survivor";
const SESSION_ID = "10165600-0000-4000-8000-000000000001";
const OPERATION_ID = "storage-fixture:progress-receipt:101656";
const MESSAGE_ID = "storage-fixture-message:101656";
const MESSAGE = "Storage fixture retained progress card";
const AGENT_DATABASE = "agents/main/agent/openclaw-agent.sqlite";
const STATE_DATABASE = "state/openclaw.sqlite";
const SNAPSHOT = {
  label: "Receipt upgrade storage fixture",
  statusHeadline: "Continuing after update",
  statusHeadlineFormat: "plain",
  lines: [
    "Published receipt retained",
    { kind: "tool", label: "Read", text: "Inspecting synthetic input", complete: true },
  ],
  plan: [
    { step: "Preserve receipt", status: "completed" },
    { step: "Resume presentation", status: "in_progress" },
  ],
  preparedBlocks: [{ text: "Public prepared presentation only", format: "plain" }],
  diffStat: { files: 1, added: 2, removed: 0 },
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });

function childOf(root, file) {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function context() {
  const directory = (name) => {
    assert(path.isAbsolute(process.env[name] ?? ""), `Missing isolated ${name}`);
    return fs.realpathSync(process.env[name]);
  };
  const root = directory("OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT");
  const artifacts = directory("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT");
  const stateDir = directory("OPENCLAW_STATE_DIR");
  const config = process.env.OPENCLAW_CONFIG_PATH;
  assert(path.isAbsolute(config ?? "") && childOf(stateDir, config));
  assert(childOf(root, stateDir), "Receipt fixture must use isolated survivor state");
  return {
    root,
    artifacts,
    stateDir,
    config,
    seedFile: path.join(artifacts, "progress-receipt-seed.json"),
  };
}

// Native read-only observation must precede every candidate owner import. It cannot
// repair a missing column or make a failed installed-driver migration look successful.
function observe(stateDir) {
  const databases = [];
  let receipt;
  let snapshotColumn;
  for (const [kind, relative] of [
    ["state", STATE_DATABASE],
    ["agent", AGENT_DATABASE],
  ]) {
    const file = path.join(stateDir, relative);
    assert.equal(fs.realpathSync(file), file, "Fixture database escaped its state root");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec("BEGIN");
      const userVersion = db.prepare("PRAGMA user_version").get().user_version;
      const metadata = db
        .prepare(
          "SELECT role, schema_version, agent_id FROM schema_meta WHERE meta_key = 'primary'",
        )
        .all()
        .map(({ role, schema_version, agent_id }) => ({ role, schema_version, agent_id }));
      let contentVersion = userVersion;
      if (kind === "state") {
        const row = db
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get("state.schema.contentVersion");
        if (row) {
          contentVersion = Math.max(userVersion, JSON.parse(row.value_json));
        }
      } else {
        const column = db
          .prepare("PRAGMA table_info(conversation_deliveries)")
          .all()
          .find((row) => row.name === "progress_snapshot_json");
        snapshotColumn = column ? { ...column } : null;
        const row = db
          .prepare("SELECT * FROM conversation_deliveries WHERE operation_id = ?")
          .get(OPERATION_ID);
        assert(row, "Fixture receipt disappeared");
        receipt = { ...row };
      }
      databases.push({ kind, relative, userVersion, contentVersion, metadata });
    } finally {
      db.close();
    }
  }
  return { databases, receipt, snapshotColumn };
}

function assertSchemas(observation, versions) {
  for (const database of observation.databases) {
    assert.equal(
      database.userVersion,
      versions[database.kind],
      `${database.relative} schema was not migrated`,
    );
    assert.equal(database.contentVersion, versions[database.kind]);
    assert.equal(database.metadata.length, 1);
    assert.equal(database.metadata[0].role, database.kind === "state" ? "global" : "agent");
    assert.equal(database.metadata[0].schema_version, versions[database.kind]);
    assert.equal(database.metadata[0].agent_id, database.kind === "agent" ? AGENT : null);
  }
}

async function withOwners(ctx, packageRootPath, baseline, operations, run, retainedEntry) {
  const packageRoot = fs.realpathSync(packageRootPath);
  const identity = readJson(
    path.join(
      ctx.artifacts,
      baseline ? "baseline-package-identity.json" : "installed-package-identity.json",
    ),
  );
  const expectedCommit = baseline
    ? BASELINE_COMMIT
    : process.env.OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_COMMIT;
  assert.match(expectedCommit ?? "", /^[a-f0-9]{40}$/u);
  assert.equal(identity.buildInfo.commit, expectedCommit);
  if (retainedEntry) {
    assert(childOf(packageRoot, retainedEntry), "Retained entry escaped its verified package");
    assert.equal(
      digest(fs.readFileSync(retainedEntry)),
      identity.files[path.relative(packageRoot, retainedEntry)]?.sha256,
      "Retained entry differs from the published package",
    );
  } else {
    assert.equal(fs.realpathSync(path.join(packageRoot, "openclaw.mjs")), identity.cli);
  }
  assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(packageRoot), {
    version: identity.version,
    buildInfo: identity.buildInfo,
    files: identity.files,
  });
  if (baseline) {
    assert.equal(identity.version, "2026.9.4");
  }
  const require = createRequire(path.join(packageRoot, "package.json"));
  const parserPath = fs.realpathSync(require.resolve("typescript"));
  assert(childOf(packageRoot, parserPath), "Use the installed package's parser");
  const ts = require(parserPath);
  assert.equal(
    ts.version,
    readJson(path.join(packageRoot, "package.json")).dependencies.typescript,
  );
  const bindings = [
    ["drain", "global-singleton", "drainGlobalSingletonLifecycleState"],
    ["closeAgents", "openclaw-agent-db", "closeOpenClawAgentDatabasesAsync"],
    [
      "closeState",
      "openclaw-state-db-cache",
      baseline ? "closeOpenClawStateDatabaseByPath" : "closeOpenClawStateDatabaseByPathAsync",
    ],
    ["read", "delivery-completion", "getConversationDeliveryOperation"],
    ...operations,
  ].map(([role, prefix, symbol]) => {
    const [name, , sha256] = resolveWorkerCellFunctionBinding(
      identity,
      packageRoot,
      prefix,
      symbol,
      ts,
    );
    const relative = `dist/${name}`;
    const alias = resolveWorkerCellExport(
      fs.readFileSync(path.join(packageRoot, relative), "utf8"),
      symbol,
    );
    return { role, relative, symbol, alias, sha256 };
  });
  const api = {};
  const errors = [];
  let result;
  try {
    for (const binding of bindings) {
      const module = await import(pathToFileURL(path.join(packageRoot, binding.relative)).href);
      assert.equal(typeof module[binding.alias], "function");
      api[binding.role] = module[binding.alias];
    }
    result = await run(api);
  } catch (error) {
    errors.push(error);
  }
  for (const [close, argument] of [
    [api.drain, "close"],
    [api.closeAgents, ctx.stateDir],
    [api.closeState, path.join(ctx.stateDir, STATE_DATABASE)],
  ]) {
    if (!close) {
      continue;
    }
    try {
      await close(argument);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Receipt owner operation or close failed");
  }
  return {
    result,
    commit: expectedCommit,
    ownerBindings: bindings,
    parser: { version: ts.version, sha256: digest(fs.readFileSync(parserPath)) },
  };
}

function receiptScope(ctx) {
  return { agentId: AGENT, storePath: path.join(ctx.stateDir, AGENT_DATABASE), env: process.env };
}

async function seed(ctx, packageRoot) {
  const workspace = path.join(ctx.root, "receipt-workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  assert(process.env.GATEWAY_AUTH_TOKEN_REF);
  fs.writeFileSync(
    ctx.config,
    `${JSON.stringify(
      {
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "token", token: process.env.GATEWAY_AUTH_TOKEN_REF },
          controlUi: { enabled: false },
        },
        agents: { defaults: { workspace, heartbeat: { every: "0m" } } },
        plugins: { enabled: false },
      },
      null,
      2,
    )}\n`,
  );
  const evidence = await withOwners(
    ctx,
    packageRoot,
    true,
    [
      ["transaction", "openclaw-agent-db", "runOpenClawAgentWriteTransaction"],
      ["identity", "session-accessor.sqlite-entry-store", "buildConversationIdentity"],
      ["upsertConversation", "session-accessor.sqlite-entry-store", "upsertConversationIdentity"],
      ["upsertSession", "session-store-runtime", "upsertSessionEntry"],
      ["header", "session-accessor.sqlite-transcript-store", "ensureTranscriptHeader"],
      ["append", "session-accessor.sqlite-transcript-store", "appendTranscriptEventInTransaction"],
      ["transcript", "session-store-runtime", "loadTranscriptEventsSync"],
      ["begin", "delivery-completion", "beginConversationDeliveryOperation"],
      ["sent", "delivery-completion", "markConversationDeliverySent"],
    ],
    async (api) => {
      const scope = receiptScope(ctx);
      const now = Date.now();
      await api.upsertSession({
        ...scope,
        sessionKey: SESSION_KEY,
        entry: { sessionId: SESSION_ID, updatedAt: now },
      });
      const identity = api.identity({
        channel: "telegram",
        accountId: "default",
        kind: "direct",
        peerId: "storage-fixture-peer",
        deliveryTarget: "storage-fixture-peer",
      });
      assert(identity);
      api.transaction(
        (database) => {
          api.upsertConversation(database, identity, now);
          const transcriptScope = {
            agentId: AGENT,
            sessionKey: SESSION_KEY,
            sessionId: SESSION_ID,
          };
          api.header(database, transcriptScope, workspace);
          assert(
            api.append(database, transcriptScope, {
              type: "message",
              id: "storage-fixture-input",
              parentId: null,
              timestamp: new Date(now).toISOString(),
              message: { role: "user", content: [{ type: "text", text: MESSAGE }], timestamp: now },
            }),
          );
        },
        { agentId: AGENT, path: scope.storePath, env: process.env },
      );
      assert.equal(api.transcript({ ...scope, sessionId: SESSION_ID }).length, 2);
      assert.equal(
        api.begin(scope, {
          operationId: OPERATION_ID,
          operationKind: "send",
          conversationRef: identity.conversationRef,
          sourceSessionKey: SESSION_KEY,
          message: MESSAGE,
        }).created,
        true,
      );
      const sent = api.sent(scope, OPERATION_ID, MESSAGE_ID);
      assert.equal(sent.status, "sent");
      assert.equal(sent.platformMessageId, MESSAGE_ID);
      assert.equal(sent.messageHash, digest(MESSAGE));
      assert.deepEqual(api.read(scope, OPERATION_ID), sent);
      return sent;
    },
  );
  const observed = observe(ctx.stateDir);
  assertSchemas(observed, { agent: 19, state: 17 });
  assert.equal(observed.snapshotColumn, null);
  writeJson(ctx.seedFile, {
    ...evidence,
    stateDir: ctx.stateDir,
    observed,
    messageIdKind: "storage-fixture; not Telegram transport evidence",
  });
}

function prepareBackup(ctx, tarball) {
  const identity = readJson(path.join(ctx.artifacts, "candidate-package-identity.json"));
  assert.equal(digest(fs.readFileSync(tarball)), identity.sha256, "Frozen candidate changed");
  const bytes = execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
    maxBuffer: 1024 * 1024,
  });
  assert.equal(digest(bytes), identity.files["package.json"].sha256);
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert.equal(manifest.version, identity.version);
  assert.deepEqual(manifest.openclaw.schemaVersions, { agent: 21, state: 17 });
  const expected = readJson(ctx.seedFile);
  assert.equal(expected.stateDir, ctx.stateDir);
  const observed = observe(ctx.stateDir);
  assert.deepEqual(observed, expected.observed);
  writeJson(path.join(ctx.artifacts, "schema-before.json"), {
    baselineVersion: "2026.9.4",
    candidateVersion: manifest.version,
    candidateSchemaVersions: manifest.openclaw.schemaVersions,
    stateDir: ctx.stateDir,
    databases: observed.databases,
    agents: [{ agentId: AGENT, databaseRelative: AGENT_DATABASE, files: [] }],
  });
}

function afterUpdate(ctx, observationRoot) {
  const before = readJson(path.join(ctx.artifacts, "schema-before.json"));
  const expected = readJson(ctx.seedFile);
  assert.equal(before.stateDir, ctx.stateDir);
  assert(childOf(ctx.artifacts, fs.realpathSync(observationRoot)));
  const observed = observe(ctx.stateDir);
  // Save native evidence even if the installed Doctor did not migrate. No repair follows.
  writeJson(path.join(ctx.artifacts, "schema-after.json"), {
    ...before,
    databases: observed.databases,
  });
  writeJson(path.join(ctx.artifacts, "progress-receipt-after-update.json"), observed);
  assertSchemas(observed, before.candidateSchemaVersions);
  assert(observed.snapshotColumn, "Installed Doctor omitted the additive snapshot column");
  assert.equal(observed.snapshotColumn.type, "TEXT");
  assert.equal(observed.snapshotColumn.notnull, 0);
  assert.equal(observed.snapshotColumn.dflt_value, null);
  assert.equal(observed.receipt.progress_snapshot_json, null);
  const oldColumns = { ...observed.receipt };
  delete oldColumns.progress_snapshot_json;
  assert.deepEqual(oldColumns, expected.observed.receipt, "Migration rewrote the old receipt");
  const directory = path.join(observationRoot, "diagnostics");
  const doctors = fs
    .readdirSync(directory)
    .filter((name) => /^process-\d+-exited\.json$/u.test(name))
    .map((name) => readJson(path.join(directory, name)))
    .filter((entry) => entry.role === "doctor" && entry.doctorResult !== undefined);
  assert(doctors.length > 0, "Missing installed-driver candidate Doctor exit evidence");
  for (const exited of doctors) {
    const started = readJson(path.join(directory, `process-${exited.pid}-started.json`));
    assert.equal(started.event, "started");
    assert.equal(exited.event, "exited");
    for (const key of ["role", "pid", "parentPid", "packageVersion"]) {
      assert.equal(started[key], exited[key]);
    }
    assert.equal(exited.packageVersion, before.candidateVersion);
    assert.equal(exited.exitCode, 0, "Candidate Doctor did not succeed in the original update");
    assert.equal(exited.doctorResult.status, "ok");
    assert.deepEqual(exited.doctorResult.failureFacts, []);
  }
  writeJson(path.join(ctx.artifacts, "progress-receipt-doctor.json"), { observationRoot, doctors });
}

function withFixtureAuthority(ctx, operation) {
  const lock = path.join(ctx.root, "progress-receipt-writer.lock");
  const fd = fs.openSync(lock, "wx", 0o600);
  const held = fs.fstatSync(fd);
  let current = true;
  const assertCurrent = () => {
    assert(current, "Storage fixture authority was released");
    const live = fs.lstatSync(lock);
    assert.equal(live.dev, held.dev);
    assert.equal(live.ino, held.ino);
    assert.equal(fs.fstatSync(fd).nlink, 1);
    assert.equal(fs.realpathSync(process.env.OPENCLAW_STATE_DIR), ctx.stateDir);
  };
  try {
    return operation(assertCurrent);
  } finally {
    current = false;
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

async function snapshot(ctx, packageRoot, reopen) {
  const expected = readJson(ctx.seedFile);
  assert.equal(expected.stateDir, ctx.stateDir);
  assertSchemas(
    observe(ctx.stateDir),
    readJson(path.join(ctx.artifacts, "schema-after.json")).candidateSchemaVersions,
  );
  const evidence = await withOwners(
    ctx,
    packageRoot,
    false,
    reopen ? [] : [["update", "delivery-completion", "updateConversationProgressSnapshot"]],
    (api) => {
      const scope = receiptScope(ctx);
      const before = api.read(scope, OPERATION_ID);
      if (reopen) {
        assert.deepEqual(
          before,
          readJson(path.join(ctx.artifacts, "progress-receipt-written.json")).result,
        );
        return before;
      }
      assert.deepEqual(before, expected.result, "Candidate reader changed the published receipt");
      return withFixtureAuthority(ctx, (assertCurrent) =>
        api.update(scope, { operationId: OPERATION_ID, progressSnapshot: SNAPSHOT, assertCurrent }),
      );
    },
  );
  const { progressSnapshot, updatedAt, ...identity } = evidence.result;
  const { updatedAt: oldUpdatedAt, ...oldIdentity } = expected.result;
  assert.deepEqual(identity, oldIdentity, "Snapshot changed receipt identity, status, or hash");
  assert.deepEqual(progressSnapshot, SNAPSHOT);
  assert(updatedAt >= oldUpdatedAt);
  const raw = observe(ctx.stateDir).receipt.progress_snapshot_json;
  assert(Buffer.byteLength(raw, "utf8") <= 64 * 1024);
  assert.deepEqual(JSON.parse(raw), SNAPSHOT);
  writeJson(
    path.join(
      ctx.artifacts,
      reopen ? "progress-receipt-reopened.json" : "progress-receipt-written.json",
    ),
    evidence,
  );
}

async function rollback(ctx) {
  const proof = readJson(path.join(ctx.artifacts, "backup-rollback.json"));
  assert.equal(proof.status, "passed", "Canonical pre-update backup restore must finish first");
  assert.equal(proof.sourceStateDir, ctx.stateDir);
  assert.equal(proof.runtime.version, "2026.9.4");
  assert.equal(digest(fs.readFileSync(proof.archive.path)), proof.archive.sha256);
  const stateDir = fs.realpathSync(proof.restoredStateDir);
  assert(childOf(path.join(ctx.root, "backup-rollback", "restored"), stateDir));
  assert.notEqual(stateDir, ctx.stateDir);
  const expected = readJson(ctx.seedFile);
  const before = observe(stateDir);
  assert.deepEqual(before, expected.observed, "Restored archive is not the pre-update state");
  const selector = path.join(proof.runtimeRoot, "selector");
  Object.assign(process.env, {
    HOME: selector,
    USERPROFILE: selector,
    OPENCLAW_HOME: selector,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  });
  for (const key of ["OPENCLAW_PROFILE", "OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
    delete process.env[key];
  }
  const restored = { ...ctx, stateDir };
  const evidence = await withOwners(
    restored,
    proof.runtime.packageRoot,
    true,
    [],
    (api) => api.read(receiptScope(restored), OPERATION_ID),
    fs.realpathSync(proof.runtime.entry),
  );
  assert.deepEqual(evidence.result, expected.result);
  assert.equal(evidence.result.progressSnapshot, undefined);
  assert.deepEqual(
    observe(stateDir),
    before,
    "Published receipt reader changed restored receipt/schema",
  );
  writeJson(path.join(ctx.artifacts, "progress-receipt-rollback.json"), {
    ...evidence,
    stateDir,
    archiveSha256: proof.archive.sha256,
    recovery:
      "Published schema19 runtime reads PRE-update backup; post-backup snapshot is absent. Not same-schema binary rollback or Telegram transport proof.",
  });
}

const [mode, argument] = process.argv.slice(2);
assert(
  ["seed", "prepare-backup", "after-update", "write-snapshot", "reopen", "rollback"].includes(mode),
  "Unknown receipt fixture mode",
);
assert.equal(process.argv.length, mode === "rollback" ? 3 : 4);
const ctx = context();
if (mode === "seed") {
  await seed(ctx, argument);
} else if (mode === "prepare-backup") {
  prepareBackup(ctx, argument);
} else if (mode === "after-update") {
  afterUpdate(ctx, argument);
} else if (mode === "rollback") {
  await rollback(ctx);
} else {
  await snapshot(ctx, argument, mode === "reopen");
}
console.log(`progress-receipt-restoration:${mode} passed (storage fixture only)`);
