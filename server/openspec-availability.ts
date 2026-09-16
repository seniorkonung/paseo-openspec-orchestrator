import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { hasOpenSpecInstallation } from "./openspec-installation";
import { openSpecAvailability } from "../shared/openspec-availability";

export async function getOpenSpecAvailability(
  { workspaceId }: RpcInput<typeof openSpecAvailability>,
  { paseo }: PluginHandlerContext,
) {
  try {
    const workspace = paseo.workspaces.ref(workspaceId);
    await workspace.refresh();
    if (!workspace.directory) {
      throw new Error("Рабочая область недоступна или не имеет директории");
    }

    return {
      installed: await hasOpenSpecInstallation(workspace.directory),
    };
  } catch (error) {
    console.error("[OpenSpec] Не удалось проверить рабочую область", { workspaceId, error });
    throw new Error("Не удалось проверить наличие OpenSpec в рабочей области");
  }
}
