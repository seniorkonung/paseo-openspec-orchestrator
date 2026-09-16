import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerOrchestratorComposerPills } from "./client/orchestrator-composer-pills";
import { OrchestratorNotificationSettingsScreen } from "./client/orchestrator-notification-settings";
import { OrchestratorPanel } from "./client/orchestrator-panel";

export default function contribute(client: PluginClientContext) {
  const removeNotificationSettings = client.addSettingsScreen({
    id: "notifications",
    title: "Уведомления OpenSpec",
    icon: "Bell",
    Component: OrchestratorNotificationSettingsScreen,
  });
  const removePanel = client.addWorkspacePanel({
    id: "orchestrator",
    title: "Оркестратор",
    icon: "Workflow",
    context: "workspace",
    locations: ["workspace"],
    Component: OrchestratorPanel,
  });
  const removeComposerPills = registerOrchestratorComposerPills(client);

  return () => {
    removeComposerPills();
    removePanel();
    removeNotificationSettings();
  };
}
