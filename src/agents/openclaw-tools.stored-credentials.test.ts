import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as mediaGenerationRegistry from "../media-generation/registry.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { finalizePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { upsertAuthProfile } from "./auth-profiles.js";
import * as authStoreRuntime from "./auth-profiles/store-runtime.js";
import { createOpenClawTools as createOpenClawToolsForTest } from "./openclaw-tools.js";

function installSnapshot(config: OpenClawConfig, media: boolean, workspaceDir: string) {
  const providers = [
    ["image-owner", "imageGenerationProviders"],
    ["video-owner", "videoGenerationProviders"],
    ["music-owner", "musicGenerationProviders"],
    ["media-owner", "mediaUnderstandingProviders"],
  ] as const;
  const prepared = createPluginMetadataSnapshotFixture({
    plugins: media
      ? providers.map(([id, contract]) => ({
          id,
          origin: "bundled",
          rootDir: "/plugins/" + id,
          source: "/plugins/" + id + "/index.js",
          manifestPath: "/plugins/" + id + "/openclaw.plugin.json",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          contracts: { [contract]: [id] },
          setup: { providers: [{ id }] },
        }))
      : [],
  });
  const policyHash = resolveInstalledPluginIndexPolicyHash(config);
  const index = { ...prepared.index, policyHash };
  setCurrentPluginMetadataSnapshot(
    finalizePluginMetadataSnapshot({
      ...prepared,
      policyHash,
      workspaceDir,
      index,
      registryIndex: index,
    }),
    { config },
  );
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
  clearSecretsRuntimeSnapshot();
  vi.unstubAllEnvs();
});

describe("Gateway stored tool credentials", () => {
  it("registers stored-only Gateway media tools without supplying inference credentials", async () => {
    await withOpenClawTestState({ label: "stored-tool-availability" }, async (state) => {
      const config: OpenClawConfig = {};
      const agentDir = state.agentDir();
      const providers = ["image-owner", "video-owner", "music-owner", "media-owner"];
      for (const provider of providers) {
        upsertAuthProfile({
          agentDir,
          profileId: `${provider}:default`,
          credential: { type: "api_key", provider, key: "synthetic-tool-key" },
        });
      }
      for (const env of [
        "IMAGE_OWNER_API_KEY",
        "VIDEO_OWNER_API_KEY",
        "MUSIC_OWNER_API_KEY",
        "MEDIA_OWNER_API_KEY",
      ]) {
        vi.stubEnv(env, "");
      }
      installSnapshot(config, true, state.workspaceDir);
      const options = {
        config,
        agentDir,
        workspaceDir: state.workspaceDir,
        disablePluginTools: true,
        wrapBeforeToolCallHook: false,
      };
      const tools = createOpenClawToolsForTest(options);
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "image_generate",
          "video_generate",
          "music_generate",
          "pdf",
          "view_image",
        ]),
      );
      // Execute the real list action against a narrow provider fixture. Auth still
      // comes from the Gateway store, not from inference or the registry fixture.
      const image = tools.find((tool) => tool.name === "image_generate")!;
      const providerLease = vi
        .spyOn(mediaGenerationRegistry, "withImageGenerationProviders")
        .mockImplementation(
          async (_config, run) =>
            await run([
              {
                id: "image-owner",
                defaultModel: "fixture-image",
                capabilities: { generate: {}, edit: { enabled: false } },
                generateImage: async () => {
                  throw new Error("No paid generation in availability test");
                },
              },
            ]),
        );
      try {
        expect(await image.execute("stored-tool-list", { action: "list" })).toMatchObject({
          details: {
            providers: [expect.objectContaining({ id: "image-owner", configured: true })],
          },
        });
      } finally {
        providerLease.mockRestore();
      }
      // An explicitly supplied scoped store remains authoritative, even when empty.
      const scoped = createOpenClawToolsForTest({
        ...options,
        authProfileStore: { version: 1, profiles: {} },
      });
      expect(
        scoped.some((tool) =>
          ["image_generate", "video_generate", "music_generate", "pdf", "view_image"].includes(
            tool.name,
          ),
        ),
      ).toBe(false);
    });
  });

  it("does not read stored tool credentials for denied, disabled, or absent media capabilities", async () => {
    await withOpenClawTestState({ label: "unused-tool-availability" }, async (state) => {
      upsertAuthProfile({
        agentDir: state.agentDir(),
        profileId: "media-owner:default",
        credential: { type: "api_key", provider: "media-owner", key: "synthetic-tool-key" },
      });
      const readStore = vi.spyOn(authStoreRuntime, "ensureAuthProfileStoreWithoutExternalProfiles");
      try {
        for (const config of [
          {
            tools: {
              deny: ["image_generate", "video_generate", "music_generate", "pdf", "view_image"],
            },
          },
          { plugins: { enabled: false } },
          {},
        ] satisfies OpenClawConfig[]) {
          installSnapshot(config, Object.keys(config).length > 0, state.workspaceDir);
          createOpenClawToolsForTest({
            config,
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            disablePluginTools: true,
          });
          expect(readStore).not.toHaveBeenCalled();
        }
      } finally {
        readStore.mockRestore();
      }
    });
  });
});
