import path from "node:path";
import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native runtime recovery" });

suite.define(() => {
  it.each(["confirm", "cancel", "mandatory", "non-admin"] as const)(
    "selects native OpenCode with explicit recovery: %s",
    async (action) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const artifactDir = createControlUiE2eArtifactDir("native-runtime-" + action);
        const key = "agent:main:native-runtime-proof";
        const row = {
          key,
          sessionId: "synthetic-native-runtime",
          kind: "direct",
          label: "Native runtime recovery",
          model: "synthetic-model",
          modelProvider: "fixture",
          agentRuntime: { id: "openclaw", source: "model" },
          permissionMode: "guarded",
          updatedAt: 1,
        };
        const model = {
          id: row.model,
          name: "Synthetic model",
          provider: "fixture",
          available: true,
          agentRuntime: { id: "openclaw", source: "model" },
          runtimeChoices: [{ agentRuntime: { id: "opencode", source: "model" }, available: true }],
        } satisfies ModelCatalogEntry;
        const result = {
          ts: 1,
          path: "",
          count: 1,
          defaults: { model: row.model, modelProvider: row.modelProvider, contextTokens: 128_000 },
          sessions: [row],
        };
        const gateway = await installMockGateway(page, {
          agentModel: "fixture/synthetic-model",
          sessionKey: key,
          sessionInfo: row,
          sessions: [row],
          models: [model],
          operatorScopes:
            action === "non-admin" ? ["operator.read", "operator.write"] : ["operator.admin"],
          deferredMethods: ["sessions.patch"],
          methodResponses: { "sessions.list": result },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        const composer = pane.locator(".agent-chat__input").first();
        const draft = composer.locator("textarea").first();
        await draft.fill("Keep this draft; do not send automatically.");
        const picker = composer.locator(".chat-controls__model-picker");
        const trigger = picker.locator("[data-chat-model-select]");
        await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("false");
        await trigger.click();
        await selectChatModelOption(picker.locator('[data-chat-model-runtime="opencode"]'));
        const initialPatch = await gateway.waitForRequest("sessions.patch");
        expect(initialPatch.params).toMatchObject({
          key,
          model: "fixture/synthetic-model",
          agentRuntime: "opencode",
        });
        const recovery = {
          action: "run-without-sandbox",
          sessionId: row.sessionId,
          lifecycleRevision: "synthetic-revision",
          expectedPermissionMode: "guarded",
          expectedSandboxMode: null,
        };
        await gateway.rejectDeferred("sessions.patch", {
          code: "INVALID_REQUEST",
          message: "OpenCode cannot run with this chat’s sandbox restrictions.",
          details: {
            code: "AGENT_RUNTIME_RESTRICTED",
            runtimeId: "opencode",
            runtimeLabel: "OpenCode",
            reason: action === "mandatory" ? "sandbox-required" : "sandbox",
            ...(action === "mandatory" || action === "non-admin" ? {} : { recovery }),
          },
        });
        // Capture the actual outcome before asserting the repair. Copied to the
        // base checkout, the confirm case retains the old dead-end error as proof.
        await page.locator("openclaw-modal-dialog, .chat-error").first().waitFor();
        await page.screenshot({
          path: path.join(artifactDir, "selection-restriction.png"),
          animations: "disabled",
        });
        if (action === "mandatory" || action === "non-admin") {
          await expect
            .poll(() => pane.locator(".chat-error").textContent())
            .toContain("Choose another model");
          expect(
            await page.getByRole("button", { name: "Run without sandbox", exact: true }).count(),
          ).toBe(0);
        } else {
          const modal = page.locator("openclaw-modal-dialog");
          await modal.waitFor();
          expect(await modal.textContent()).toContain("full access");
          expect(await modal.textContent()).toContain("Gateway host");
          expect(await modal.textContent()).toContain("only this chat");
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
          if (action === "confirm") {
            await gateway.deferNext("sessions.patch");
          }
          await modal
            .getByRole("button", {
              name: action === "confirm" ? "Run without sandbox" : "Cancel",
              exact: true,
            })
            .click();
          if (action === "confirm") {
            const retry = await gateway.waitForRequest("sessions.patch", { after: 1 });
            expect(retry.params).toEqual({
              key,
              expectedSessionId: row.sessionId,
              model: "fixture/synthetic-model",
              agentRuntime: "opencode",
              permissionMode: "full",
              sandboxMode: "off",
              expectedPermissionMode: "guarded",
              expectedSandboxMode: null,
              expectedLifecycleRevision: recovery.lifecycleRevision,
            });
            const selected = {
              ...row,
              permissionMode: "full",
              agentRuntime: { id: "opencode", source: "session-key" },
              updatedAt: 2,
            };
            await gateway.setSessionsListResponse({ ...result, sessions: [selected] });
            await gateway.resolveDeferred("sessions.patch", {
              ok: true,
              key,
              path: "",
              entry: {
                sessionId: row.sessionId,
                permissionMode: "full",
                sandboxMode: "off",
                agentRuntimeOverride: "opencode",
                providerOverride: "fixture",
                modelOverride: row.model,
                updatedAt: 2,
              },
              resolved: {
                model: row.model,
                modelProvider: "fixture",
                agentRuntime: selected.agentRuntime,
              },
            });
            await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("false");
            await trigger.click();
            await expect
              .poll(() =>
                picker
                  .locator('[data-chat-model-runtime="opencode"]')
                  .getAttribute("aria-selected"),
              )
              .toBe("true");
            await page.screenshot({
              path: path.join(artifactDir, "after-confirmed-selection.png"),
              animations: "disabled",
            });
          } else {
            await expect
              .poll(() => pane.locator(".chat-error").textContent())
              .toContain("Choose another model");
          }
        }
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(
          action === "confirm" ? 2 : 1,
        );
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(
          (await gateway.getRequests()).some((request) =>
            ["config.set", "config.patch", "config.apply"].includes(request.method),
          ),
        ).toBe(false);
        expect(await draft.inputValue()).toBe("Keep this draft; do not send automatically.");
      });
    },
  );
});
