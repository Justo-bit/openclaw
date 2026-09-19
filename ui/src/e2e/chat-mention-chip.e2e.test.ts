import { expect, it } from "vitest";
import type { ComposerEditor } from "../components/composer-editor.ts";
import { composerValue } from "../test-helpers/composer-editor.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  installMockGateway,
  waitForCommittedChatRoute,
  waitForGatewayRecoveryScope,
} from "./new-session-page.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({ name: "composer mention chips" });
const users = [
  { profileId: "00000001-1111-4111-8111-000000000101", displayName: "Avery Finch", online: true },
  { profileId: "00000002-1111-4111-8111-000000000102", displayName: "Avery Finch", online: false },
];
const scenario = {
  models: [{ id: "demo-model", name: "Demo Model", provider: "demo" }],
  agentModel: "demo/demo-model",
  presenceUsers: [
    {
      self: true,
      id: "demo-viewer",
      identity: { type: "profile" as const, id: "demo-viewer" },
      name: "Demo viewer",
    },
  ],
  methodResponses: {
    "users.mentionable": { users, truncated: false },
    "sessions.create": { key: "agent:main:mention-chip-created", runStarted: true },
  },
};

suite.define(() => {
  it.each(["chat", "new"])(
    "keeps the caret after replacing or prefixing a selected mention in %s",
    async (route) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, scenario);
        await page.goto(
          route === "new"
            ? `${suite.server.baseUrl}new`
            : controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"),
        );
        await waitForGatewayRecoveryScope(page);
        const editor = page.locator(
          route === "new"
            ? ".new-session-page__message"
            : ".agent-chat__composer-combobox > openclaw-composer-editor",
        );
        const input = editor.locator(".cm-content");
        const chips = editor.locator(".composer-chip--mention");
        const menu = page.getByRole("listbox", { name: "Mention a person" });
        for (const edit of ["replace", "prefix"]) {
          await input.pressSequentially("@Avery");
          await menu.getByRole("option").first().click();
          await expect.poll(() => chips.count()).toBe(1);
          await input.pressSequentially("please review");
          await editor.evaluate(
            (element: ComposerEditor, end) => {
              element.focus();
              element.setSelectionRange(0, end);
            },
            edit === "replace" ? 12 : 0,
          );
          if (edit === "replace") {
            await page.keyboard.insertText("@Bo");
            await expect.poll(() => composerValue(editor)).toBe("@Bo please review");
            expect(await editor.evaluate((element: ComposerEditor) => element.selectionStart)).toBe(
              3,
            );
            await expect.poll(() => chips.count()).toBe(0);
            await expect.poll(() => page.locator(".composer-context-strip").count()).toBe(0);
            await page.keyboard.insertText("b");
            expect(await composerValue(editor)).toBe("@Bob please review");
            await input.press("ControlOrMeta+a");
            await input.press("Backspace");
            await expect.poll(() => composerValue(editor)).toBe("");
          } else {
            await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
            await page.evaluate(() => navigator.clipboard.writeText("@X "));
            await input.press("ControlOrMeta+v");
            await expect.poll(() => composerValue(editor)).toBe("@X @Avery Finch please review");
            expect(await editor.evaluate((element: ComposerEditor) => element.selectionStart)).toBe(
              3,
            );
            await expect.poll(() => chips.count()).toBe(1);
            await page.keyboard.insertText("today ");
            await expect.poll(() => chips.count()).toBe(1);
            expect(await composerValue(editor)).toBe("@X today @Avery Finch please review");
          }
        }
        await page
          .getByRole("button", {
            name: route === "new" ? "Start session" : "Send message",
            exact: true,
          })
          .click();
        const submitted = await gateway.waitForRequest(
          route === "new" ? "sessions.create" : "chat.send",
        );
        expect(submitted.params).toMatchObject({
          message: "@X today @Avery Finch please review",
          mentions: [{ profileId: users[0].profileId, start: 9, end: 21 }],
        });
      });
    },
  );

  it.each([1280, 390])(
    "restores and atomically edits mentions without changing recipients at %ipx",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, scenario);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        await waitForGatewayRecoveryScope(page);
        const editor = page.locator(".agent-chat__composer-combobox > openclaw-composer-editor");
        const input = editor.locator(".cm-content");
        const chips = editor.locator(".composer-chip--mention");
        const menu = page.getByRole("listbox", { name: "Mention a person" });
        for (const index of [0, 1]) {
          await input.pressSequentially("@Avery");
          await menu.getByRole("option").nth(index).click();
          await expect.poll(() => chips.count()).toBe(index + 1);
        }
        await input.pressSequentially("please review");
        const raw = "@Avery Finch @Avery Finch please review";
        await expect.poll(() => composerValue(editor)).toBe(raw);
        expect(await chips.first().getAttribute("aria-label")).toBe("mention: Avery Finch");
        expect(await page.locator(".composer-context-strip").textContent()).toContain(
          "Will notify",
        );
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await input.press("ControlOrMeta+a");
        await input.press("ControlOrMeta+c");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(raw);
        await input.press("ArrowRight");
        await waitForCommittedComposerDraft(
          page,
          "chat:v3:agent:main:main\u0000agent:main",
          raw,
          0,
        );
        await page.reload();
        await expect.poll(() => composerValue(editor)).toBe(raw);
        await expect.poll(() => chips.count()).toBe(2);
        await editor.evaluate((element: ComposerEditor) => {
          element.focus();
          element.setSelectionRange(0, 0);
        });
        await input.press("ArrowRight");
        expect(await editor.evaluate((element: ComposerEditor) => element.selectionStart)).toBe(12);
        await input.press("Backspace");
        await expect.poll(() => composerValue(editor)).toBe(" @Avery Finch please review");
        await expect.poll(() => chips.count()).toBe(1);
        await page.keyboard.insertText("🦞");
        await expect.poll(() => composerValue(editor)).toBe("🦞 @Avery Finch please review");
        await expect.poll(() => chips.count()).toBe(1);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        expect(request.params).toMatchObject({
          message: "🦞 @Avery Finch please review",
          mentions: [{ profileId: users[1].profileId, start: 3, end: 15 }],
        });
        await expect.poll(() => composerValue(editor)).toBe("");
      });
    },
  );

  it.each(["chat", "new"])(
    "keeps copied mention text unbound and preserves Remove mention in %s",
    async (route) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, scenario);
        const draftUrl =
          route === "new"
            ? `${suite.server.baseUrl}new`
            : controlUiSessionUrl(suite.server.baseUrl, "agent:main:main");
        await page.goto(draftUrl);
        await waitForGatewayRecoveryScope(page);
        const editor = page.locator(
          route === "new"
            ? ".new-session-page__message"
            : ".agent-chat__composer-combobox > openclaw-composer-editor",
        );
        const input = editor.locator(".cm-content");
        const chips = editor.locator(".composer-chip--mention");
        await input.pressSequentially("Please ask @Avery");
        await page
          .getByRole("listbox", { name: "Mention a person" })
          .getByRole("option")
          .first()
          .click();
        await expect.poll(() => chips.count()).toBe(1);
        const raw = "Please ask @Avery Finch ";
        expect(await composerValue(editor)).toBe(raw);
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await input.press("ControlOrMeta+a");
        await input.press("ControlOrMeta+c");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(raw);
        // Replacing a selection with identical clipboard text must still remove its recipient binding.
        await input.press("ControlOrMeta+v");
        await expect.poll(() => composerValue(editor)).toBe(raw);
        await expect.poll(() => chips.count()).toBe(0);
        await expect.poll(() => page.locator(".composer-context-strip").count()).toBe(0);
        await page
          .getByRole("button", {
            name: route === "new" ? "Start session" : "Send message",
            exact: true,
          })
          .click();
        const submitted = await gateway.waitForRequest(
          route === "new" ? "sessions.create" : "chat.send",
        );
        expect(submitted.params).toMatchObject({ message: "Please ask @Avery Finch" });
        expect(submitted.params).not.toHaveProperty("mentions");
        if (route === "new") {
          await waitForCommittedChatRoute(page);
        } else {
          await expect.poll(() => composerValue(editor)).toBe("");
        }
        await page.goto(draftUrl);
        await waitForGatewayRecoveryScope(page);
        await expect.poll(() => composerValue(editor)).toBe("");
        await input.pressSequentially("@Avery");
        await page
          .getByRole("listbox", { name: "Mention a person" })
          .getByRole("option")
          .first()
          .click();
        await expect.poll(() => chips.count()).toBe(1);
        await page.getByRole("button", { name: "Remove mention", exact: true }).click();
        await expect.poll(() => chips.count()).toBe(0);
        expect(await composerValue(editor)).toBe("@Avery Finch ");
      });
    },
  );
});
