import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getOpenSpecAvailability } from "./server/openspec-availability";
import {
  OrchestratorNotificationService,
} from "./server/orchestrator-notifications";
import { OrchestratorNotificationSettingsStore } from "./server/orchestrator-notification-settings";
import { OrchestratorController } from "./server/orchestrator-controller";
import { openSpecAvailability } from "./shared/openspec-availability";
import {
  orchestratorControl,
  orchestratorGet,
  orchestratorWait,
} from "./shared/orchestrator";
import {
  readOrchestratorNotificationSettingsRpc,
  saveOrchestratorNotificationSettingsRpc,
  testOrchestratorNotificationRpc,
} from "./shared/orchestrator-notifications";

export default function contribute(server: PluginServerContext) {
  const notificationSettings = new OrchestratorNotificationSettingsStore();
  const notifications = new OrchestratorNotificationService({
    settings: notificationSettings,
  });
  const orchestrator = new OrchestratorController({ notifications });

  server.handle(readOrchestratorNotificationSettingsRpc, async () => {
    const settings = await notificationSettings.read();
    return { revision: settings.revision, values: settings.values };
  });
  server.handle(saveOrchestratorNotificationSettingsRpc, async ({ revision, values }) => {
    try {
      const result = await notificationSettings.save(revision, values);
      if (result.status === "conflict") {
        return {
          status: "conflict" as const,
          revision: result.settings.revision,
          values: result.settings.values,
          error: "Настройки изменились в другом окне; загружены последние значения",
        };
      }
      return {
        status: "saved" as const,
        revision: result.settings.revision,
        values: result.settings.values,
      };
    } catch (error) {
      return {
        status: "invalid" as const,
        revision,
        error: error instanceof Error ? error.message : "Не удалось сохранить настройки",
      };
    }
  });
  server.handle(testOrchestratorNotificationRpc, async ({ values }) => {
    try {
      await notifications.test(values);
      return { ok: true as const, message: "Тестовое уведомление отправлено" };
    } catch (error) {
      return {
        ok: false as const,
        message:
          error instanceof Error ? error.message : "Не удалось отправить тестовое уведомление",
      };
    }
  });
  server.handle(openSpecAvailability, getOpenSpecAvailability);
  server.handle(orchestratorGet, async ({ workspaceId }, { paseo }) => {
    try {
      return await orchestrator.get(workspaceId, paseo);
    } catch (error) {
      console.error("[OpenSpec] Не удалось загрузить состояние оркестратора", {
        workspaceId,
        error,
      });
      throw new Error("Не удалось загрузить состояние оркестратора");
    }
  });
  server.handle(orchestratorWait, async ({ workspaceId, revision }, { paseo }) => {
    try {
      return await orchestrator.wait(workspaceId, revision, paseo);
    } catch (error) {
      console.error("[OpenSpec] Ошибка ожидания состояния оркестратора", {
        workspaceId,
        error,
      });
      throw new Error("Не удалось синхронизировать состояние оркестратора");
    }
  });
  server.handle(
    orchestratorControl,
    async ({ workspaceId, expectedRevision, command }, { paseo }) => {
      try {
        return await orchestrator.control(
          workspaceId,
          expectedRevision,
          command,
          paseo,
        );
      } catch (error) {
        console.error("[OpenSpec] Ошибка управления оркестратором", {
          workspaceId,
          command,
          error,
        });
        throw new Error("Не удалось выполнить команду оркестратора");
      }
    },
  );

  return () => orchestrator.close();
}
