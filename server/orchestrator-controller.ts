import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ControlCommand, OrchestratorSnapshot } from "../shared/orchestrator.ts";
import { DemoOrchestratorEngine } from "./demo-orchestrator-engine.ts";
import type { OrchestratorEngine } from "./orchestrator-engine.ts";
import { OrchestratorLedger, type WaitResult } from "./orchestrator-ledger.ts";

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
}

export class OrchestratorController {
  readonly #ledger: OrchestratorLedger;
  readonly #engine: OrchestratorEngine;

  constructor(options: OrchestratorControllerOptions = {}) {
    this.#ledger = options.ledger ?? new OrchestratorLedger();
    this.#engine = options.createEngine?.(this.#ledger) ?? new DemoOrchestratorEngine(this.#ledger);
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

    if (current.lifecycle.availableCommand !== command) {
      return {
        status: "rejected",
        reason: "not_allowed",
        message: "Команда недоступна в текущем состоянии оркестратора",
        snapshot: current,
      };
    }

    try {
      this.#engine.command(workspaceId, command);
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
    this.#engine.dispose();
    await this.#ledger.close();
  }

  async #ensureWorkspace(workspaceId: string, paseo: PaseoApi): Promise<void> {
    if (this.#ledger.has(workspaceId)) return;

    const workspace = paseo.workspaces.ref(workspaceId);
    await workspace.refresh();
    if (!workspace.directory) {
      throw new Error("Рабочая область недоступна или не имеет директории");
    }

    await this.#ledger.open(workspaceId);
    this.#engine.initialize(workspaceId);
  }
}
