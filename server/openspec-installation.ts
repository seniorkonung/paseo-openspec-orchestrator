import { stat } from "node:fs/promises";
import { join } from "node:path";

function isMissingPath(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = Reflect.get(error, "code");
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function hasOpenSpecInstallation(workspaceDirectory: string): Promise<boolean> {
  try {
    const configuration = await stat(join(workspaceDirectory, "openspec", "config.yaml"));
    return configuration.isFile();
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}
