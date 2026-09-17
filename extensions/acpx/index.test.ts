import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import setupPlugin from "./setup-api.js";

const { createAcpxRuntimeServiceMock, tryDispatchAcpReplyHookMock } = vi.hoisted(() => ({
  createAcpxRuntimeServiceMock: vi.fn(),
  tryDispatchAcpReplyHookMock: vi.fn(),
}));

vi.mock("./register.runtime.js", () => ({
  createAcpxRuntimeService: createAcpxRuntimeServiceMock,
}));

vi.mock("openclaw/plugin-sdk/acp-runtime-backend", () => ({
  tryDispatchAcpReplyHook: tryDispatchAcpReplyHookMock,
}));

import plugin from "./index.js";

type AcpxAutoEnableProbe = Parameters<OpenClawPluginApi["registerAutoEnableProbe"]>[0];

function registerAcpxAutoEnableProbe(): AcpxAutoEnableProbe {
  const probes: AcpxAutoEnableProbe[] = [];
  setupPlugin.register(
    createTestPluginApi({
      registerAutoEnableProbe(probe) {
        probes.push(probe);
      },
    }),
  );
  const probe = probes[0];
  if (!probe) {
    throw new Error("expected ACPX setup plugin to register an auto-enable probe");
  }
  return probe;
}

describe("acpx plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the runtime service and reply_dispatch hook", () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);
    const openKeyedStore = vi.fn();

    const api = createTestPluginApi({
      pluginConfig: { stateDir: "/tmp/acpx" },
      runtime: { state: { openKeyedStore } } as never,
      registerService: vi.fn(),
      on: vi.fn(),
    });

    plugin.register(api);

    expect(createAcpxRuntimeServiceMock).toHaveBeenCalledWith({
      pluginConfig: api.pluginConfig,
      openKeyedStore: expect.any(Function),
    });
    const params = createAcpxRuntimeServiceMock.mock.calls[0]?.[0] as {
      openKeyedStore: typeof openKeyedStore;
    };
    params.openKeyedStore({ namespace: "test", maxEntries: 1 });
    expect(openKeyedStore).toHaveBeenCalledWith({ namespace: "test", maxEntries: 1 });
    expect(api.registerService).toHaveBeenCalledWith(service);
    expect(api.on).toHaveBeenCalledWith("reply_dispatch", tryDispatchAcpReplyHookMock, {
      eligibleDispatchKinds: ["acp"],
    });
  });

  it("does not touch runtime state while registering metadata-only plugin APIs", () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);

    const api = createTestPluginApi({
      pluginConfig: {},
      runtime: {} as never,
      registerService: vi.fn(),
      on: vi.fn(),
    });

    expect(() => plugin.register(api)).not.toThrow();
    expect(api.registerService).toHaveBeenCalledWith(service);
  });

  it("declares setup auto-enable reasons for ACPX-owned ACP config", () => {
    const probe = registerAcpxAutoEnableProbe();

    expect(probe({ config: { acp: { enabled: true } }, env: {} })).toBe("ACP runtime configured");
    expect(probe({ config: { acp: { backend: "acpx" } }, env: {} })).toBe("ACP runtime configured");
    expect(probe({ config: { acp: { enabled: true, backend: "custom-runtime" } }, env: {} })).toBe(
      null,
    );
  });
});
