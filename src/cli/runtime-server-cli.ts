import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Command } from "commander";
import { readSecretFileSync } from "../infra/secret-file.js";
import { defaultRuntime } from "../runtime.js";

/** Foreground runtime service; never installs or restarts the Gateway. */
export function registerRuntimeServerCli(program: Command): void {
  program
    .command("runtime-server")
    .description("Run the dedicated native inference runtime with Gateway-mediated tools")
    .requiredOption("--token-file <path>", "Private file containing the runtime bearer token")
    .requiredOption("--gateway-id <id>", "Exact Gateway identity allowed by this listener")
    .requiredOption(
      "--runtime-config <path>",
      "Private startup configuration for local models, credentials, and workspace views",
    )
    .option("--port <port>", "Loopback listener port", "18791")
    .action(
      async (options: {
        gatewayId: string;
        runtimeConfig: string;
        port: string;
        tokenFile: string;
      }) => {
        const token = readSecretFileSync(options.tokenFile, "Built-in runtime token", {
          maxBytes: 4096,
        });
        const port = Number(options.port);
        if (!token || !Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error("Provide a private runtime token file and a valid listener port");
        }
        const { startBuiltinRuntimeServer } = await import("../agents/builtin-runtime/server.js");
        const { createNativeRuntime, NativeRuntimeConfigSchema } =
          await import("../agents/builtin-runtime/native-runtime.js");
        const localConfig = NativeRuntimeConfigSchema.parse(
          JSON.parse(
            readSecretFileSync(options.runtimeConfig, "Native runtime configuration", {
              maxBytes: 1024 * 1024,
            }),
          ),
        );
        const runtime = await createNativeRuntime(localConfig);
        const server = await startBuiltinRuntimeServer({
          token,
          gatewayId: options.gatewayId,
          workspaceIds: localConfig.workspaces.map((workspace) => workspace.id),
          runtime,
          port,
        });
        console.log(
          "Built-in runtime listening on ws://127.0.0.1:" + server.port + "/runtime (protocol 1)",
        );
        await new Promise<void>((resolve) => {
          const stop = () => resolve();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        await server.close();
      },
    );
  program
    .command("runtime-workspace-id <path>")
    .description("Print the canonical workspace scope for a built-in runtime server")
    .action(async (path: string) => {
      defaultRuntime.writeStdout(
        createHash("sha256")
          .update(await realpath(path))
          .digest("hex") + "\n",
      );
    });
}
