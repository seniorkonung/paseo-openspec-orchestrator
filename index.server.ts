import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getOpenSpecAvailability } from "./server/openspec-availability";
import { OrchestratorController } from "./server/orchestrator-controller";
import { openSpecAvailability } from "./shared/openspec-availability";
import {
  orchestratorControl,
  orchestratorGet,
  orchestratorWait,
} from "./shared/orchestrator";

export default function contribute(server: PluginServerContext) {
  const orchestrator = new OrchestratorController();

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
