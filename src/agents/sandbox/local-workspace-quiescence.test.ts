import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  current: vi.fn(),
  read: vi.fn(),
  browsers: vi.fn(),
  browserCurrent: vi.fn(),
}));
vi.mock("./registry.js", () => ({
  readRegistry: mocks.read,
  readBrowserRegistry: mocks.browsers,
  assertSandboxRegistryEntryCurrent: mocks.current,
  assertSandboxBrowserRegistryEntryCurrent: mocks.browserCurrent,
}));
vi.mock("./docker.js", () => ({
  DOCKER_SANDBOX_ENGINE: { id: "docker" },
  bindPodmanSandboxEngine: () => ({ id: "podman" }),
  execContainer: mocks.command,
  validateSandboxContainerEngineTarget: async () => {},
}));
import { quiesceLocalWorkspace } from "./local-workspace-quiescence.js";
const id = "a".repeat(64);
const entry = {
  containerName: "owned",
  backendId: "docker",
  sessionKey: "owner",
  workspaceDir: "/owned/projection",
};
beforeEach(() => {
  mocks.command.mockReset();
  mocks.current.mockReset();
  mocks.read.mockReset().mockResolvedValue({ entries: [entry] });
  mocks.browsers.mockReset().mockResolvedValue({ entries: [] });
  mocks.browserCurrent.mockReset();
});

it("persists exact runtime custody before pausing and resumes only that id", async () => {
  const persist = vi.fn();
  mocks.command.mockImplementation(async (_engine, args: string[]) => {
    if (args[0] === "inspect") {
      return { code: 0, stdout: id + " true false", stderr: "" };
    }
    if (args[0] === "pause") {
      expect(persist).toHaveBeenLastCalledWith([{ name: "owned", id }]);
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const resume = await quiesceLocalWorkspace({
    workspaceDir: "/owned/projection",
    retained: [],
    persist,
    assertCurrent: () => {},
  });
  await resume();
  expect(mocks.command.mock.calls.map((call) => call[1][0])).toEqual([
    "inspect",
    "pause",
    "unpause",
  ]);
  expect(mocks.command.mock.calls[2]?.[1]).toEqual(["unpause", id]);
  expect(persist).toHaveBeenLastCalledWith([]);
});

it("recovers its recorded paused generation but never adopts a foreign pause", async () => {
  mocks.command.mockResolvedValue({ code: 0, stdout: id + " true true", stderr: "" });
  const input = { workspaceDir: "/owned/projection", persist: vi.fn(), assertCurrent: () => {} };
  await expect(quiesceLocalWorkspace({ ...input, retained: [] })).rejects.toThrow("another owner");
  const resume = await quiesceLocalWorkspace({ ...input, retained: [{ name: "owned", id }] });
  await resume();
  expect(mocks.command.mock.calls.some((call) => call[1][0] === "pause")).toBe(false);
});

it("revalidates the runtime after inspection before pause", async () => {
  mocks.command.mockImplementation(async () => {
    mocks.current.mockImplementation(() => {
      throw new Error("retired");
    });
    return { code: 0, stdout: id + " true false", stderr: "" };
  });
  await expect(
    quiesceLocalWorkspace({
      workspaceDir: "/owned/projection",
      retained: [],
      persist: () => {},
      assertCurrent: () => {},
    }),
  ).rejects.toThrow("retired");
  expect(mocks.command).toHaveBeenCalledOnce();
});

it("fences browser writers through the same exact workspace owner", async () => {
  const browserId = "b".repeat(64);
  mocks.browsers.mockResolvedValue({
    entries: [
      { ...entry, containerName: "browser-owned" },
      { ...entry, containerName: "foreign", workspaceDir: "/other" },
    ],
  });
  mocks.command.mockImplementation(async (_engine, args: string[]) => ({
    code: 0,
    stderr: "",
    stdout:
      args[0] === "inspect" ? `${args.at(-1) === "browser-owned" ? browserId : id} true false` : "",
  }));
  const persist = vi.fn();
  const resume = await quiesceLocalWorkspace({
    workspaceDir: entry.workspaceDir,
    retained: [],
    persist,
    assertCurrent: () => {},
  });
  expect(persist).toHaveBeenLastCalledWith([
    { name: "owned", id },
    { name: "browser-owned", id: browserId },
  ]);
  expect(mocks.browserCurrent).toHaveBeenCalledTimes(2);
  await resume();
  expect(
    mocks.command.mock.calls.filter((call) => call[1][0] === "unpause").map((call) => call[1][1]),
  ).toEqual([browserId, id]);
});

it("does not interpret engine failure as absence", async () => {
  mocks.command.mockResolvedValue({ code: 125, stdout: "", stderr: "connection refused" });
  await expect(
    quiesceLocalWorkspace({
      workspaceDir: "/owned/projection",
      retained: [],
      persist: () => {},
      assertCurrent: () => {},
    }),
  ).rejects.toThrow("could not be inspected");
});
