import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveDynamicModelAuthProfile } from "../embedded-agent-runner/model.registry-resolution.js";
import { OAUTH_REFRESH_CALL_TIMEOUT_MS } from "./constants.js";
import * as oauthOwner from "./oauth-manager.js";
import { isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { loadPersistedSharedAuthProfileStore } from "./persisted.js";
import { runtimeAuthProfileRowsCache } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { updateAuthProfileStoreWithLock } from "./store-runtime.js";
import type { OAuthCredential } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const profileId = "model-selection:default";
const provider = "model-selection";

function originalCredential(): OAuthCredential {
  return {
    type: "oauth",
    provider,
    access: "synthetic-original-access",
    refresh: "synthetic-original-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "synthetic-same-account",
  };
}

function controlledRefresh(credential: OAuthCredential, options?: { buildFailure: boolean }) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const built = createDeferredCore();
  const rotated: OAuthCredential = {
    ...credential,
    access: "synthetic-rotated-access",
    refresh: "synthetic-rotated-refresh",
    expires: Date.now() + 7_200_000,
  };
  const refreshCredential = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return rotated;
  });
  const manager = oauthOwner.createOAuthManager({
    canRefreshCredential: async () => true,
    readBootstrapCredential: () => null,
    buildApiKey: async (_provider, current) => {
      built.resolve();
      if (options?.buildFailure) {
        throw new Error(`Synthetic build failed: ${current.access} ${current.refresh}`);
      }
      return current.access;
    },
    refreshCredential,
  });
  return { manager, entered, release, built, rotated, refreshCredential };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  "pinned",
  "automatic",
  "historical peer",
  "cancelled",
  "revoked",
  "rotated again",
  "removed",
  "refresh rejected",
  "rotated build rejected",
  "adopted settlement rejected",
  "superseding owner rejected",
] as const)("joins one durable refresh before model selection: %s", async (scenario) => {
  await withOpenClawTestState({ label: "oauth-model-selection" }, async (state) => {
    const credential = originalCredential();
    await persistAuthProfileBatch({
      stateDir: state.stateDir,
      profiles: [{ profileId, credential }],
    });
    const agentDir = state.agentDir(scenario === "historical peer" ? "peer" : "main");
    if (scenario === "historical peer") {
      await state.writeAuthProfiles({ version: 1, profiles: { [profileId]: credential } }, "peer");
      // Auth credential semantics retains historical-peer settlement; current writes deduplicate copies.
      writePersistedAuthProfileStoreRaw(
        { version: 1, profiles: { [profileId]: credential } },
        agentDir,
      );
    }
    const databasePath =
      scenario === "historical peer"
        ? resolveAuthProfileDatabasePath(agentDir)
        : resolveSharedAuthStorePath();
    const refresh = controlledRefresh(credential, {
      buildFailure:
        scenario === "rotated build rejected" ||
        scenario === "adopted settlement rejected" ||
        scenario === "superseding owner rejected",
    });
    const reads = [0, 1].map(() => ({
      entered: createDeferredCore(),
      release: createDeferredCore(),
    }));
    const joining = createDeferredCore();
    const prepare = runtimeAuthProfileRowsCache.prepare.bind(runtimeAuthProfileRowsCache);
    let readCount = 0;
    vi.spyOn(runtimeAuthProfileRowsCache, "prepare").mockImplementation((db, reader) => {
      const prepared = prepare(db, reader);
      if (db !== databasePath) {
        return prepared;
      }
      const barrier = reads[readCount++];
      return {
        ...prepared,
        async read() {
          const rows = await prepared.read();
          barrier?.entered.resolve();
          await barrier?.release.promise;
          return rows;
        },
      };
    });
    const join = oauthOwner.waitForOwnedOAuthRefreshes;
    vi.spyOn(oauthOwner, "waitForOwnedOAuthRefreshes").mockImplementation((params) => {
      const pending = join(params);
      joining.resolve();
      return pending;
    });
    const controller = new AbortController();
    const refusal = new Error("Selected model owner closed");
    let revoked = false;
    const selecting = resolveDynamicModelAuthProfile({
      provider,
      modelId: "synthetic-model",
      agentDir,
      authProfileId: scenario === "automatic" ? undefined : profileId,
      abortSignal: controller.signal,
      assertCurrent: () => {
        if (revoked) {
          throw refusal;
        }
      },
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let refreshing: ReturnType<typeof refresh.manager.resolveOAuthAccess> | undefined;
    try {
      expect(await Promise.race([reads[0]!.entered.promise, selecting])).toBeUndefined();
      refreshing = refresh.manager.resolveOAuthAccess({
        store: { version: 1, profiles: { [profileId]: credential } },
        profileId,
        credential,
        agentDir: state.agentDir(),
        cfg: {},
        forceRefresh: true,
      });
      expect(await Promise.race([refresh.entered.promise, refreshing])).toBeUndefined();
      reads[0]!.release.resolve();
      expect(await Promise.race([joining.promise, selecting])).toBeUndefined();
      expect(readCount).toBe(1);
      if (scenario === "cancelled") {
        controller.abort(refusal);
        const cancelled = await selecting;
        expect(cancelled).toMatchObject({
          ok: false,
          error: { name: "AbortError", cause: refusal },
        });
        expect(readCount).toBe(1);
        const pending = loadPersistedSharedAuthProfileStore(state.env)?.profiles[profileId];
        expect(pending?.type === "oauth" && isPendingOAuthRefreshFence(pending)).toBe(true);
      } else if (scenario === "revoked") {
        revoked = true;
      }
      if (scenario === "refresh rejected") {
        const failedRefresh = expect(refreshing).rejects.toMatchObject({
          name: "OAuthManagerRefreshError",
        });
        refresh.release.reject(new Error("Synthetic refresh settlement failure"));
        expect(await selecting).toMatchObject({
          ok: false,
          error: { message: "Synthetic refresh settlement failure" },
        });
        await failedRefresh;
        expect(readCount).toBe(1);
        return;
      }
      if (
        scenario === "rotated build rejected" ||
        scenario === "adopted settlement rejected" ||
        scenario === "superseding owner rejected"
      ) {
        const failedRefresh = expect(refreshing).rejects.toMatchObject({
          name: "OAuthManagerRefreshError",
        });
        const adopted = {
          ...refresh.rotated,
          access: "synthetic-adopted-access",
          refresh: "synthetic-adopted-refresh",
          expires: Date.now() + 10_800_000,
        };
        if (scenario !== "rotated build rejected") {
          await persistAuthProfileBatch({
            stateDir: state.stateDir,
            profiles: [{ profileId, credential: adopted }],
            allowOAuthGenerationReplacement: true,
          });
        }
        if (scenario === "superseding owner rejected") {
          refresh.release.reject(new Error("Synthetic provider failure before adoption"));
        } else {
          refresh.release.resolve();
        }
        const result = await selecting;
        await failedRefresh;
        expect(result.ok).toBe(false);
        expect(inspect(result, { depth: 8 })).not.toContain(refresh.rotated.access);
        expect(inspect(result, { depth: 8 })).not.toContain(refresh.rotated.refresh);
        expect(inspect(result, { depth: 8 })).not.toContain(adopted.access);
        expect(inspect(result, { depth: 8 })).not.toContain(adopted.refresh);
        expect(readCount).toBe(1);
        return;
      }
      refresh.release.resolve();
      expect((await refreshing)?.credential).toEqual(refresh.rotated);
      if (scenario === "cancelled" || scenario === "revoked") {
        const result = await selecting;
        if (scenario === "revoked") {
          expect(result).toEqual({ ok: false, error: refusal });
        }
        expect(readCount).toBe(1);
        return;
      }
      expect(await Promise.race([reads[1]!.entered.promise, selecting])).toBeUndefined();
      if (scenario === "rotated again" || scenario === "removed") {
        await updateAuthProfileStoreWithLock({
          profileId,
          updater: (store) => {
            if (scenario === "removed") {
              delete store.profiles[profileId];
            } else {
              store.profiles[profileId] = {
                ...refresh.rotated,
                access: "synthetic-independent-access",
              };
            }
            return true;
          },
        });
      }
      reads[1]!.release.resolve();
      const result = await selecting;
      if (scenario === "rotated again" || scenario === "removed") {
        expect(result).toMatchObject({
          ok: false,
          error: { name: "AuthProfileRuntimeReadStaleError" },
        });
      } else {
        expect(result).toEqual({
          ok: true,
          value: { authProfileId: profileId, authProfileMode: "oauth" },
        });
      }
      expect(readCount).toBe(2);
      expect(refresh.refreshCredential).toHaveBeenCalledOnce();
    } finally {
      refresh.release.resolve();
      for (const read of reads) {
        read.release.resolve();
      }
      await Promise.allSettled([selecting, ...(refreshing ? [refreshing] : [])]);
    }
  });
});

it("keeps durable settlement owned after caller timeout without renewing waiter deadlines", async () => {
  await withOpenClawTestState({ label: "oauth-model-selection-timeout" }, async (state) => {
    const credential = originalCredential();
    await persistAuthProfileBatch({
      stateDir: state.stateDir,
      profiles: [{ profileId, credential }],
    });
    const refresh = controlledRefresh(credential);
    const databasePath = resolveSharedAuthStorePath();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const refreshing = refresh.manager
      .resolveOAuthAccess({
        store: { version: 1, profiles: { [profileId]: credential } },
        profileId,
        credential,
        agentDir: state.agentDir(),
        cfg: {},
        forceRefresh: true,
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    try {
      await refresh.entered.promise;
      await oauthOwner.waitForOwnedOAuthRefreshes({
        databasePath: state.statePath("unrelated.sqlite"),
        providers: [provider],
      });
      await oauthOwner.waitForOwnedOAuthRefreshes({ databasePath, providers: ["other-provider"] });
      await oauthOwner.waitForOwnedOAuthRefreshes({
        databasePath,
        providers: [provider],
        profileId: "other-profile",
      });
      const firstWait = oauthOwner.waitForOwnedOAuthRefreshes({
        databasePath,
        providers: [provider],
      });
      const firstRefusal = expect(firstWait).rejects.toThrow("exceeded hard timeout");
      await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_CALL_TIMEOUT_MS);
      await firstRefusal;
      expect(await refreshing).toMatchObject({ error: { name: "OAuthManagerRefreshError" } });
      const lateWait = oauthOwner.waitForOwnedOAuthRefreshes({
        databasePath,
        providers: [provider],
      });
      const lateRefusal = expect(lateWait).rejects.toThrow("exceeded hard timeout");
      await vi.advanceTimersByTimeAsync(0);
      await lateRefusal;
      vi.useRealTimers();
      refresh.release.resolve();
      await refresh.built.promise;
      await Promise.resolve();
      expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles[profileId]).toEqual(
        refresh.rotated,
      );
      await oauthOwner.waitForOwnedOAuthRefreshes({ databasePath, providers: [provider] });
      expect(refresh.refreshCredential).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      refresh.release.resolve();
      await refreshing;
      await refresh.built.promise;
    }
  });
});
