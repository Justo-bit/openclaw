import type { UsersPrefsSetResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import { saveUserPreferences } from "../../app/user-prefs-cache.ts";
import {
  decodeIdentityPreferences,
  decodePalettePreference,
  PALETTE_PREFERENCE_KEY,
  type PaletteSessionPreference,
  encodeIdentityPreferences,
  loadBrowserPreferences,
  patchNewSessionPreference,
  PREFS_MIGRATION_KEY,
  replaceBrowserPreference,
  type NewSessionPreference,
} from "./preferences.ts";

type Client = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
type Owner = { client: Client; hello: object; gatewayUrl: string; profileId: string };
type PreferenceEvent = "loaded" | "changed";

// A handshake has one preference writer even while /new and the launcher coexist.
// Each draft retains its own selection; only the authoritative preference projection is shared.
const owners = new WeakMap<Client, WeakMap<object, Map<string, DraftIdentityPreferences>>>();

export function acquireDraftIdentityPreferences(owner: Owner): DraftIdentityPreferences {
  let handshakes = owners.get(owner.client);
  if (!handshakes) {
    handshakes = new WeakMap();
    owners.set(owner.client, handshakes);
  }
  let profiles = handshakes.get(owner.hello);
  if (!profiles) {
    profiles = new Map();
    handshakes.set(owner.hello, profiles);
  }
  const key = JSON.stringify([owner.gatewayUrl, owner.profileId]);
  let state = profiles.get(key);
  if (!state) {
    const entries = profiles;
    const created = new DraftIdentityPreferences(owner, () => {
      if (entries.get(key) === created) {
        entries.delete(key);
      }
    });
    state = created;
    profiles.set(key, state);
  }
  return state;
}

export class DraftIdentityPreferences {
  mode: "loading" | "remote" | "local" = "loading";
  preferences: Record<string, NewSessionPreference> = {};
  palettePreference: PaletteSessionPreference | null = null;
  private readonly listeners = new Map<(event: PreferenceEvent) => void, () => boolean>();
  private readonly loading: Promise<void>;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly owner: Owner,
    private readonly release: () => void,
  ) {
    this.loading = this.load();
  }

  subscribe(listener: (event: PreferenceEvent) => void, isCurrent: () => boolean) {
    this.listeners.set(listener, isCurrent);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.release();
      }
    };
  }

  private hasCurrentBinding() {
    return [...this.listeners.values()].some((isCurrent) => isCurrent());
  }

  patch(agentId: string, patch: NewSessionPreference, isCurrent: () => boolean) {
    const write = async () => {
      await this.loading;
      if (!isCurrent()) {
        return;
      }
      const { client, gatewayUrl } = this.owner;
      if (this.mode === "local") {
        patchNewSessionPreference(gatewayUrl, agentId, patch);
        return;
      }
      // Merge at the serialized write boundary, not against a surface's stale snapshot.
      const next = { ...this.preferences[agentId], ...patch };
      try {
        const result = await saveUserPreferences(client, {
          entries: encodeIdentityPreferences({ [agentId]: next }),
        });
        if (result.status !== "ok") {
          return;
        }
        this.preferences = { ...this.preferences, [agentId]: next };
        if (this.hasCurrentBinding()) {
          replaceBrowserPreference(gatewayUrl, agentId, next);
        }
        this.publish("changed");
      } catch {
        // A failed write does not replace the last Gateway-confirmed projection.
      }
    };
    this.writing = this.writing.then(write, write);
  }

  setPalettePreference(
    preference: PaletteSessionPreference | null,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const write = async () => {
      await this.loading;
      if (!isCurrent() || this.mode !== "remote") {
        return false;
      }
      try {
        const result = await saveUserPreferences(this.owner.client, {
          entries: { [PALETTE_PREFERENCE_KEY]: preference },
        });
        if (result.status !== "ok") {
          return false;
        }
        this.palettePreference = preference;
        this.publish("changed");
        return true;
      } catch {
        return false;
      }
    };
    const pending = this.writing.then(write, write);
    this.writing = pending.then(() => {});
    return pending;
  }

  private publish(event: PreferenceEvent) {
    for (const [listener, isCurrent] of this.listeners) {
      if (isCurrent()) {
        listener(event);
      }
    }
  }

  private async load() {
    const { client, gatewayUrl, profileId } = this.owner;
    try {
      const { loadUserPreferences } = await import("../../app/user-prefs-request.ts");
      // Import completion does not retain a live surface or its authority.
      if (!this.hasCurrentBinding()) {
        return;
      }
      const result = await loadUserPreferences(client, profileId);
      if (result.status !== "ok") {
        this.mode = "local";
        return;
      }
      this.palettePreference = decodePalettePreference(result.entries[PALETTE_PREFERENCE_KEY]);
      let preferences = decodeIdentityPreferences(result.entries);
      const browserPreferences = loadBrowserPreferences(gatewayUrl);
      if (result.entries[PREFS_MIGRATION_KEY] !== true) {
        const missing = Object.fromEntries(
          Object.entries(browserPreferences).filter(
            ([agentId]) => !Object.hasOwn(preferences, agentId),
          ),
        );
        const entries = [
          ...Object.entries(encodeIdentityPreferences(missing)),
          [PREFS_MIGRATION_KEY, true] as const,
        ];
        let failed = false;
        for (let offset = 0; offset < entries.length; offset += 32) {
          // No renderer remains authoritative after the final binding releases this handshake.
          if (!this.hasCurrentBinding()) {
            failed = true;
            break;
          }
          const batch = Object.fromEntries(entries.slice(offset, offset + 32));
          let response: UsersPrefsSetResult;
          try {
            response = await saveUserPreferences(client, { entries: batch });
          } catch {
            failed = true;
            break;
          }
          if (response.status !== "ok") {
            failed = true;
            break;
          }
          Object.assign(preferences, decodeIdentityPreferences(batch));
        }
        if (failed) {
          preferences = { ...browserPreferences, ...preferences };
        }
      }
      this.preferences = preferences;
      this.mode = "remote";
      if (this.hasCurrentBinding()) {
        for (const [agentId, preference] of Object.entries(preferences)) {
          replaceBrowserPreference(gatewayUrl, agentId, preference);
        }
      }
    } catch {
      this.mode = "local";
    } finally {
      this.publish("loaded");
    }
  }
}
