import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { OrchestratorWorkspaceDisplay } from "../shared/orchestrator-notifications.ts";
import type { ControlCommand, OrchestratorSnapshot } from "../shared/orchestrator.ts";
import { createChangeSelectionService } from "./change-selection.ts";
import { OpenSpecOrchestratorEngine } from "./openspec-orchestrator-engine.ts";
import { inspectMiseToolchain } from "./mise-toolchain.ts";
import type { OrchestratorEngine } from "./orchestrator-engine.ts";
import { OrchestratorLedger, type WaitResult } from "./orchestrator-ledger.ts";
import {
  NoopOrchestratorNotificationSink,
  type OrchestratorNotificationSink,
} from "./orchestrator-notifications.ts";

type PaseoApi = PluginHandlerContext["paseo"];

export type ControlResult =
  | { status: "accepted"; snapshot: OrchestratorSnapshot }
  | {
      status: "rejected";
      reason: "stale" | "not_allowed" | "unavailable";
      message: string;
      snapshot: OrchestratorSnapshot;
    };

export interface OrchestratorControllerOptions {
  ledger?: OrchestratorLedger;
  createEngine?: (ledger: OrchestratorLedger) => OrchestratorEngine;
  notifications?: OrchestratorNotificationSink;
}

export class OrchestratorController {
  readonly #ledger: OrchestratorLedger;
  readonly #engine: OrchestratorEngine;
  readonly #notifications: OrchestratorNotificationSink;

  constructor(options: OrchestratorControllerOptions = {}) {
    this.#ledger = options.ledger ?? new OrchestratorLedger();
    this.#notifications = options.notifications ?? new NoopOrchestratorNotificationSink();
    this.#engine =
      options.createEngine?.(this.#ledger) ??
      new OpenSpecOrchestratorEngine(this.#ledger, { notifications: this.#notifications });
  }

  async get(workspaceId: string, paseo: PaseoApi): Promise<OrchestratorSnapshot> {
    await this.#ensureWorkspace(workspaceId, paseo);
    return this.#ledger.get(workspaceId);
  }

  async wait(workspaceId: string, revision: string, paseo: PaseoApi): Promise<WaitResult> {
    await this.#ensureWorkspace(workspaceId, paseo);
    return this.#ledger.wait(workspaceId, revision);
  }

  async control(
    workspaceId: string,
    expectedRevision: string,
    command: ControlCommand,
    paseo: PaseoApi,
  ): Promise<ControlResult> {
    await this.#ensureWorkspace(workspaceId, paseo);
    const current = this.#ledger.get(workspaceId);
    if (current.revision !== expectedRevision) {
      return {
        status: "rejected",
        reason: "stale",
        message: "Состояние оркестратора уже изменилось; данные обновлены",
        snapshot: current,
      };
    }

    if (command !== "clear" && current.lifecycle.availableCommand !== command) {
      return {
        status: "rejected",
        reason: "not_allowed",
        message: "Команда недоступна в текущем состоянии оркестратора",
        snapshot: current,
      };
    }

    try {
      this.#engine.command(workspaceId, command);
      if (command === "clear") {
        // Для destructive-команды подтверждаем запись до ответа UI: после
        // этого ответ означает, что очистка переживёт немедленное завершение
        // процесса, а не только что изменила in-memory проекцию.
        await this.#ledger.flush(workspaceId);
        const persisted = this.#ledger.get(workspaceId).persistence;
        if (persisted.status === "degraded") {
          return {
            status: "rejected",
            reason: "unavailable",
            message: "Состояние очищено в памяти, но не сохранено на диске",
            snapshot: this.#ledger.get(workspaceId),
          };
        }
      }
      return { status: "accepted", snapshot: this.#ledger.get(workspaceId) };
    } catch (error) {
      console.error("[OpenSpec] Не удалось выполнить команду оркестратора", {
        workspaceId,
        command,
        error,
      });
      return {
        status: "rejected",
        reason: "unavailable",
        message: "Оркестратор временно не может выполнить команду",
        snapshot: this.#ledger.get(workspaceId),
      };
    }
  }

  async close(): Promise<void> {
    await this.#engine.dispose();
    await this.#ledger.close();
  }

  async #ensureWorkspace(workspaceId: string, paseo: PaseoApi): Promise<void> {
    if (this.#ledger.has(workspaceId)) return;

    const workspace = paseo.workspaces.ref(workspaceId);
    const snapshot = await workspace.refresh();
    if (!workspace.directory) {
      throw new Error("Рабочая область недоступна или не имеет директории");
    }

    await this.#ledger.open(workspaceId);
    const workspaceDisplay = workspaceDisplayFromSnapshot(snapshot);
    this.#engine.initialize(workspaceId, {
      workspaceDirectory: workspace.directory,
      workspaceDisplay,
      refreshWorkspaceDisplay: async () => {
        const refreshed = await workspace.refresh();
        if (!refreshed) {
          throw new Error("Рабочая область больше недоступна");
        }
        return workspaceDisplayFromSnapshot(refreshed);
      },
      // Публичный SDK возвращает сохранённые профили через config.get().
      // Источник: https://paseo.sh/docs/sdk/reference#clientconfig
      readAgentProfiles: async () => (await paseo.config.get()).config.agentProfiles ?? [],
      miseToolchain: inspectMiseToolchain,
      changeSelection: createChangeSelectionService({
        // Глобальный paseo.agents.create создаёт новый workspace для cwd.
        // Workspace-handle сохраняет размещение агента в текущем окружении.
        // Источник: https://paseo.sh/docs/sdk/workspaces#start-an-agent-in-a-workspace
        createAgent: (options) => workspace.agents.create(options),
      }),
    });
  }
}

function workspaceDisplayFromSnapshot(
  snapshot:
    | {
        projectCustomName?: string | null;
        projectDisplayName?: string | null;
        title?: string | null;
        name?: string | null;
      }
    | null
    | undefined,
): OrchestratorWorkspaceDisplay {
  return {
    projectName: preferredName(snapshot?.projectCustomName, snapshot?.projectDisplayName),
    workspaceName: preferredName(snapshot?.title, snapshot?.name),
  };
}

function preferredName(
  primary: string | null | undefined,
  fallback: string | null | undefined,
): string | null {
  const normalizedPrimary = primary?.trim();
  if (normalizedPrimary) return normalizedPrimary;
  const normalizedFallback = fallback?.trim();
  return normalizedFallback || null;
}
