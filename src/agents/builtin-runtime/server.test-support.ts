import { readFile } from "node:fs/promises";
import { createNativeRuntime, NativeRuntimeConfigSchema } from "./native-runtime.js";
import { startBuiltinRuntimeServer } from "./server.js";

const config = NativeRuntimeConfigSchema.parse(
  JSON.parse(await readFile(process.argv[2]!, "utf8")),
);
for (const model of config.models) {
  model.headers = { ...model.headers, "x-runtime-pid": String(process.pid) };
}
const runtime = await createNativeRuntime(config);
const server = await startBuiltinRuntimeServer({
  token: "synthetic-runtime-test-token-0000000000",
  gatewayId: "gateway-test",
  workspaceIds: config.workspaces.map((workspace) => workspace.id),
  runtime,
});
// The owner must keep the startup snapshot rather than reading this later mutation.
process.env.NATIVE_TEST_KEY = "changed-after-runtime-startup";
process.send?.({
  type: "ready",
  port: server.port,
  epoch: server.epoch,
  pid: process.pid,
  inheritedGatewayCredential: process.env.GATEWAY_TEST_KEY !== undefined,
});
process.on("message", () => {
  void server.close().then(() => process.exit(0));
});
