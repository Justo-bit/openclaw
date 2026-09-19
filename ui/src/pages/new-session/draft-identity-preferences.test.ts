import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { acquireDraftIdentityPreferences } from "./draft-identity-preferences.ts";
import { PALETTE_PREFERENCE_KEY, PREFS_MIGRATION_KEY } from "./preferences.ts";

function fixture() {
  let release!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: Record<string, unknown>[] = [];
  const request = vi.fn(async (method: string, params?: { entries?: Record<string, unknown> }) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: { [PREFS_MIGRATION_KEY]: true } };
    }
    if (method === "users.prefs.set") {
      writes.push(params?.entries ?? {});
      if (writes.length === 1) {
        await firstWrite;
      }
      return { status: "ok" };
    }
    throw new Error(method);
  });
  const owner = {
    client: { request } as unknown as GatewayBrowserClient,
    hello: {},
    gatewayUrl: "ws://gateway.example",
    profileId: "alice",
  };
  const state = acquireDraftIdentityPreferences(owner);
  const stop = state.subscribe(
    () => {},
    () => true,
  );
  return { owner, state, request, writes, release, stop };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("shared new-session identity preferences", () => {
  it("serializes and merges ordinary new-session selections", async () => {
    const { owner, state, writes, release, stop } = fixture();
    try {
      const palette = acquireDraftIdentityPreferences(owner);
      expect(palette).toBe(state);
      await vi.waitFor(() => expect(state.mode).toBe("remote"));
      state.patch("main", { model: "example/model", worktree: true }, () => true);
      palette.patch("main", { where: { kind: "device", id: "runner" } }, () => true);
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      release();
      await vi.waitFor(() => expect(writes).toHaveLength(2));
      expect(writes[1]).toEqual({
        "new-session.v1:main": {
          model: "example/model",
          worktree: true,
          where: { kind: "device", id: "runner" },
        },
      });
    } finally {
      release();
      stop();
    }
  });

  it("drops a queued write from a retired surface and isolates a new handshake", async () => {
    const { owner, state, writes, release, stop } = fixture();
    try {
      await vi.waitFor(() => expect(state.mode).toBe("remote"));
      let current = true;
      state.patch("main", { worktree: true }, () => true);
      state.patch("main", { where: { kind: "cloud", id: "old-cloud" } }, () => current);
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      current = false;
      const replacement = acquireDraftIdentityPreferences({
        ...owner,
        hello: {},
        profileId: "bob",
      });
      expect(replacement).not.toBe(state);
      release();
      await vi.waitFor(() => expect(state.preferences.main).toEqual({ worktree: true }));
      await Promise.resolve();
      expect(writes).toHaveLength(1);
    } finally {
      release();
      stop();
    }
  });
});

it("serializes palette set/delete without overwriting simultaneous ordinary defaults", async () => {
  const { state, writes, release, stop } = fixture();
  try {
    await vi.waitFor(() => expect(state.mode).toBe("remote"));
    state.patch("main", { worktree: true }, () => true);
    const remembered = state.setPalettePreference(
      { agentId: "other", selection: { worktree: false } },
      () => true,
    );
    state.patch("main", { folder: "/normal" }, () => true);
    const cleared = state.setPalettePreference(null, () => true);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    release();
    expect(await remembered).toBe(true);
    expect(await cleared).toBe(true);
    expect(writes).toEqual([
      { "new-session.v1:main": { worktree: true } },
      { [PALETTE_PREFERENCE_KEY]: { agentId: "other", selection: { worktree: false } } },
      { "new-session.v1:main": { worktree: true, folder: "/normal" } },
      { [PALETTE_PREFERENCE_KEY]: null },
    ]);
    expect(state.preferences).toEqual({ main: { worktree: true, folder: "/normal" } });
    expect(state.palettePreference).toBeNull();
  } finally {
    release();
    stop();
  }
});

it("drops a queued palette write when its authenticated owner retires", async () => {
  const { state, writes, release, stop } = fixture();
  try {
    await vi.waitFor(() => expect(state.mode).toBe("remote"));
    state.patch("main", { worktree: true }, () => true);
    let current = true;
    const remembered = state.setPalettePreference(
      { agentId: "other", selection: { worktree: false } },
      () => current,
    );
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    current = false;
    release();
    expect(await remembered).toBe(false);
    expect(writes).toHaveLength(1);
    expect(state.palettePreference).toBeNull();
  } finally {
    release();
    stop();
  }
});

it("does not issue a newer remembered selection until the older server write settles", async () => {
  const { state, writes, release, stop } = fixture();
  try {
    await vi.waitFor(() => expect(state.mode).toBe("remote"));
    const older = { agentId: "first", selection: { worktree: false } };
    const newer = { agentId: "second", selection: { worktree: true } };
    const first = state.setPalettePreference(older, () => true);
    const second = state.setPalettePreference(newer, () => true);
    await vi.waitFor(() => expect(writes).toEqual([{ [PALETTE_PREFERENCE_KEY]: older }]));
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(writes).toEqual([
      { [PALETTE_PREFERENCE_KEY]: older },
      { [PALETTE_PREFERENCE_KEY]: newer },
    ]);
    expect(state.palettePreference).toEqual(newer);
  } finally {
    release();
    stop();
  }
});

it.each(["ordinary", "palette"] as const)(
  "notifies surviving subscribers after a confirmed %s write outlives its initiator",
  async (kind) => {
    const { state, writes, release, stop } = fixture();
    let initiatorCurrent = true;
    const retired = vi.fn();
    const surviving = vi.fn();
    const stopRetired = state.subscribe(retired, () => initiatorCurrent);
    const stopSurviving = state.subscribe(surviving, () => true);
    try {
      await vi.waitFor(() => expect(state.mode).toBe("remote"));
      retired.mockClear();
      surviving.mockClear();
      if (kind === "ordinary") {
        state.patch("main", { worktree: true }, () => initiatorCurrent);
      } else {
        void state.setPalettePreference(
          { agentId: "main", selection: { worktree: true } },
          () => initiatorCurrent,
        );
      }
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      initiatorCurrent = false;
      release();
      await vi.waitFor(() =>
        expect(
          kind === "ordinary"
            ? state.preferences.main?.worktree
            : state.palettePreference?.selection.worktree,
        ).toBe(true),
      );
      expect(surviving).toHaveBeenCalledWith("changed");
      expect(retired).not.toHaveBeenCalled();
    } finally {
      release();
      stopRetired();
      stopSurviving();
      stop();
    }
  },
);
