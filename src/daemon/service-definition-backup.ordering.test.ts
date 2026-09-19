import "./service-definition-backup.mocks.test-support.js";
import fs from "node:fs/promises";
import { DOMParser } from "linkedom";
import { expect, it, vi } from "vitest";
import { restoreGatewayServiceDefinitionBackup } from "./service-definition-backup.js";
import { fixture, native, readRetainedReceipt } from "./service-definition-backup.test-support.js";
import { reconcileGatewayServiceDefinition } from "./service-reconciliation.js";

vi.mock("./service-audit.js", () => ({
  auditGatewayServiceConfig: async () => ({ issues: [], definitionDrift: [] }),
}));
vi.mock("./service-layout.js", async (original) => ({
  ...(await original<typeof import("./service-layout.js")>()),
  gatewayServiceCommandMatchesRoot: async () => true,
}));

function taskReference(xml: string): string {
  return new DOMParser().parseFromString(xml, "text/xml").querySelector("Exec > Command")!
    .textContent;
}

it.each([
  "before-create",
  "create-failed",
  "after-create",
  "unverified-create",
  "after-delete",
  "normal",
])("keeps the registered task runnable while retiring a new VBS launcher: %s", async (fault) => {
  const f = await fixture("win32");
  const launcher = f.files[1]!;
  const referenced = () => taskReference(f.task());
  await f.install();
  expect(referenced()).toBe(launcher);
  await fs.access(referenced());
  const receipt = await f.capture.finish();
  const execute = native.task.getMockImplementation()!;
  native.task.mockImplementation(async (args: string[]) => {
    if (args[0] === "/Create" && fault === "before-create") {
      throw new Error("interrupted task restoration");
    }
    if (args[0] === "/Create" && fault === "create-failed") {
      return { code: 1, stdout: "", stderr: "injected create failure" };
    }
    const result = await execute(args);
    if (args[0] === "/Create" && fault === "after-create") {
      throw new Error("interrupted task restoration");
    }
    if (args[0] === "/Create" && fault === "unverified-create") {
      f.setTask(f.task().replace("<Count>0</Count>", "<Count>7</Count>"));
    }
    return result;
  });
  const unlink = fs.unlink.bind(fs);
  const retire = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
    if (file === launcher && fault === "normal") {
      expect(f.task()).toBe(f.originalTask);
      await fs.access(referenced());
    }
    await unlink(file);
    if (file === launcher && fault === "after-delete") {
      throw new Error("interrupted launcher retirement");
    }
  });
  const restore = () => restoreGatewayServiceDefinitionBackup({ ...f, receipt });
  if (fault === "normal") {
    await restore();
  } else {
    const error = await restore().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    await fs.access(referenced());
    if (fault !== "after-delete") {
      await fs.access(launcher);
      expect(String(error)).toContain(launcher);
      expect(String(error)).toContain("Restore and verify");
    }
    retire.mockRestore();
    native.task.mockImplementation(execute);
    const retained = await readRetainedReceipt(f.capture.backupPaths);
    if (fault === "unverified-create") {
      await expect(
        restoreGatewayServiceDefinitionBackup({ ...f, receipt: retained }),
      ).rejects.toThrow("Scheduled Task changed");
      await fs.access(launcher);
      return;
    }
    await restoreGatewayServiceDefinitionBackup({ ...f, receipt: retained });
  }
  expect(f.task()).toBe(f.originalTask);
  expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
  await fs.access(referenced());
  await expect(fs.stat(launcher)).rejects.toMatchObject({ code: "ENOENT" });
});

it("warns with the retained launcher and recovery step when compensation cannot restore task XML", async () => {
  const f = await fixture("win32");
  const warnings: string[] = [];
  const execute = native.task.getMockImplementation()!;
  let creates = 0;
  native.task.mockImplementation(async (args: string[]) => {
    if (args[0] === "/Create" && ++creates === 2) {
      return { code: 1, stdout: "", stderr: "injected restore failure" };
    }
    return execute(args);
  });
  await expect(
    reconcileGatewayServiceDefinition({
      env: f.env,
      root: "/old",
      command: f.command,
      expectedCommand: f.command,
      install: async (hooks) => {
        await f.install(hooks);
        throw new Error("injected activation failure");
      },
      warn: (message) => warnings.push(message),
    }),
  ).rejects.toThrow("UPDATE_NATIVE_AUTHORITY");
  expect(
    warnings.some(
      (message) => message.includes(f.files[1]!) && message.includes("Restore and verify"),
    ),
  ).toBe(true);
  await fs.access(taskReference(f.task()));
  await fs.access(f.files[1]!);
});
