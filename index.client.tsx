import type { PluginClientContext } from "@getpaseo/plugin/client";
import { OrchestratorPanel } from "./client/orchestrator-panel";

export default function contribute(client: PluginClientContext) {
  return client.addWorkspacePanel({
    id: "orchestrator",
    title: "Оркестратор",
    icon: "Workflow",
    context: "workspace",
    locations: ["workspace"],
    Component: OrchestratorPanel,
  });
}
