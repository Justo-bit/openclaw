import { createHash } from "node:crypto";
import { vi } from "vitest";

type LaunchdFileFixture = {
  files: Map<string, string>;
  fileModes: Map<string, number>;
  dirs: Set<string>;
  dirModes: Map<string, number>;
  fileWrites: Array<{ path: string; data: string }>;
};

export function readLaunchdFixtureFileState(state: LaunchdFileFixture, file: string) {
  const contents = state.files.get(file);
  return contents === undefined
    ? null
    : {
        sha256: createHash("sha256").update(contents).digest("hex"),
        mode: state.fileModes.get(file) ?? 0o666,
        dev: 1,
        ino: 1,
        size: Buffer.byteLength(contents),
        mtimeMs: 0,
        ctimeMs: 0,
      };
}

function createLaunchdFileReadMocks(state: {
  files: Map<string, string>;
  fileModes: Map<string, number>;
}) {
  const readContents = (file: string) => {
    const data = state.files.get(file);
    if (data === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), {
        code: "ENOENT",
      });
    }
    return data;
  };
  return {
    open: vi.fn(async (file: string) => {
      const data = readContents(file);
      const mode = state.fileModes.get(file) ?? 0o666;
      return {
        readFile: async () => Buffer.from(data),
        stat: async () => ({ mode }),
        close: async () => undefined,
      };
    }),
    readFile: vi.fn(async (file: string) => readContents(file)),
  };
}

export function buildLaunchdFileSystemFixture(
  actual: typeof import("node:fs/promises"),
  state: LaunchdFileFixture,
) {
  const wrapped = {
    ...actual,
    ...createLaunchdFileReadMocks(state),
    access: vi.fn(async (p: string) => {
      const key = p;
      if (
        (state.files.has(key) && state.files.get(key) !== "dangling-launchagent-symlink") ||
        state.dirs.has(key)
      ) {
        return;
      }
      throw Object.assign(new Error(`ENOENT: no such file or directory, access '${key}'`), {
        code: "ENOENT",
      });
    }),
    lstat: vi.fn(async (p: string) => {
      const key = p;
      if (state.files.has(key) || state.dirs.has(key)) {
        return {
          isSymbolicLink: () => state.files.get(key) === "dangling-launchagent-symlink",
        };
      }
      throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${key}'`), {
        code: "ENOENT",
      });
    }),
    mkdir: vi.fn(async (p: string, opts?: { mode?: number }) => {
      const key = p;
      state.dirs.add(key);
      state.dirModes.set(key, opts?.mode ?? 0o777);
    }),
    stat: vi.fn(async (p: string) => {
      const key = p;
      if (state.dirs.has(key)) {
        return { mode: state.dirModes.get(key) ?? 0o777 };
      }
      if (state.files.has(key)) {
        return { mode: state.fileModes.get(key) ?? 0o666 };
      }
      throw new Error(`ENOENT: no such file or directory, stat '${key}'`);
    }),
    chmod: vi.fn(async (p: string, mode: number) => {
      const key = p;
      if (state.dirs.has(key)) {
        state.dirModes.set(key, mode);
        return;
      }
      if (state.files.has(key)) {
        state.fileModes.set(key, mode);
        return;
      }
      throw new Error(`ENOENT: no such file or directory, chmod '${key}'`);
    }),
    unlink: vi.fn(async (p: string) => {
      state.files.delete(p);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const data = state.files.get(from);
      if (data === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${from}'`), {
          code: "ENOENT",
        });
      }
      state.files.delete(from);
      state.files.set(to, data);
      const mode = state.fileModes.get(from);
      state.fileModes.delete(from);
      if (mode !== undefined) {
        state.fileModes.set(to, mode);
      }
      state.fileWrites.push({ path: to, data });
    }),
    writeFile: vi.fn(async (p: string, contents: string | Uint8Array, opts?: { mode?: number }) => {
      const key = p;
      const data = typeof contents === "string" ? contents : Buffer.from(contents).toString("utf8");
      state.files.set(key, data);
      state.fileWrites.push({ path: key, data });
      state.dirs.add(key.split("/").slice(0, -1).join("/"));
      state.fileModes.set(key, opts?.mode ?? 0o666);
    }),
  };
  return { ...wrapped, default: wrapped };
}
