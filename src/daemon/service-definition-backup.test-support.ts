import fs from "node:fs/promises";
import { GatewayServiceDefinitionBackupReceiptSchema } from "./service-stage.js";

export async function readRetainedReceipt(backupPaths: readonly string[]) {
  const checkpoint = backupPaths.find((file) => file.endsWith(".receipt.bak"));
  if (!checkpoint) {
    throw new Error("The service definition receipt was not retained.");
  }
  return GatewayServiceDefinitionBackupReceiptSchema.parse(
    JSON.parse(await fs.readFile(checkpoint, "utf8")),
  );
}
