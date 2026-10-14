import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { OrchestratorWorkspaceDisplay } from "../shared/orchestrator-notifications.ts";
import type { ControlCommand, OrchestratorSnapshot } from "../shared/orchestrator.ts";
import { createChangeArtifactCreationService } from "./change-artifact-creation.ts";
import { createChangeInitializationService } from "./change-initialization.ts";
import { createChangePublicationService } from "./change-publication.ts";
import { createChangeReviewService } from "./change-review.ts";
import { createChangeFindingResolutionService } from "./change-finding-resolution.ts";
import { createImplementationFindingResolutionService } from "./implementation-finding-resolution.ts";
import { createImplementationRunVerifier } from "./implementation-run-verification.ts";
import { createChangeTaskExecutionService } from "./change-task-execution.ts";
import { createChangeArchiveService } from "./change-archive.ts";
import { readGitBranch } from "./git-branch.ts";
import { readGitWorktreeStatus } from "./git-worktree.ts";
import { OpenSpecOrchestratorEngine } from "./openspec-orchestrator-engine.ts";
import { inspectMiseToolchain } from "./mise-toolchain.ts";
import { verifyOpenSpecChange } from "./openspec-change.ts";
import { createPlanningBranchService } from "./planning-branch.ts";
import { createImplementationBranchService } from "./implementation-branch.ts";
import { createImplementationReviewService } from "./implementation-review.ts";
import { createPhaseWorkService } from "./phase-work.ts";
import { createPhaseTaskPlanningService } from "./phase-task-planning.ts";
import { createRootBranchService } from "./root-branch-state.ts";
import { createRootPullRequestService } from "./root-pull-request.ts";
import type { OrchestratorEngine } from "./orchestrator-engine.ts";
import { OrchestratorLedger, type WaitResult } from "./orchestrator-ledger.ts";
import {
  NoopOrchestratorNotificationSink,
  type OrchestratorNotificationSink,
} from "./orchestrator-notifications.ts";
import { createOpenSpecWorkflow } from "./workflow/steps/index.ts";
import { AgentResources } from "./agent-resources.ts";
import { AgentCleanupError } from "./agent-cleanup-error.ts";
import type { AgentReleaseMode } from "./agent-resource-registry.ts";

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
  resources?: AgentResources;
}

export class OrchestratorController {
  readonly #ledger: OrchestratorLedger;
  readonly #engine: OrchestratorEngine;
  readonly #notifications: OrchestratorNotificationSink;
  readonly #resources: AgentResources;

  constructor(options: OrchestratorControllerOptions = {}) {
    this.#ledger = options.ledger ?? new OrchestratorLedger();
    this.#notifications = options.notifications ?? new NoopOrchestratorNotificationSink();
    this.#resources = options.resources ?? new AgentResources();
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
        message: error instanceof AgentCleanupError ? error.message : "Оркестратор временно не может выполнить команду",
        snapshot: this.#ledger.get(workspaceId),
      };
    }
  }

  async close(): Promise<void> {
    this.#resources.stop();
    try {
      await this.#engine.dispose();
    } finally {
      try { await this.#resources.close(); }
      finally { await this.#ledger.close(); }
    }
  }

  async #ensureWorkspace(workspaceId: string, paseo: PaseoApi): Promise<void> {
    // Ошибка очистки не скрывает UI: следующий запуск покажет её в lifecycle.
    await this.#resources.initialize(paseo).catch((error: unknown) => {
      console.warn("[OpenSpec] Восстановление ресурсов агентов требует повторной очистки", {
        code: error instanceof AgentCleanupError ? error.code : "UNKNOWN",
      });
    });
    if (this.#ledger.has(workspaceId)) return;

    const workspace = paseo.workspaces.ref(workspaceId);
    const snapshot = await workspace.refresh();
    if (!workspace.directory) {
      throw new Error("Рабочая область недоступна или не имеет директории");
    }

    await this.#ledger.open(workspaceId);
    const workspaceDisplay = workspaceDisplayFromSnapshot(snapshot);
    const workspaceDirectory = workspace.directory;
    // Публичный SDK возвращает сохранённые профили через config.get().
    // Источник: https://paseo.sh/docs/sdk/reference#clientconfig
    const readAgentProfiles = async () =>
      (await paseo.config.get()).config.agentProfiles ?? [];
    // Глобальный paseo.agents.create создаёт новый workspace для cwd.
    // Workspace-handle сохраняет размещение агента в текущем окружении.
    // Источник: https://paseo.sh/docs/sdk/workspaces#start-an-agent-in-a-workspace
    const createAgent = (options: Parameters<typeof workspace.agents.create>[0]) =>
      this.#resources.create(workspace, paseo, options);
    const agentLifecycle = {
      createAgent,
      releaseAgent: (agent: { readonly id: string }, mode: AgentReleaseMode, closeLocalResources: () => Promise<void>) =>
        this.#resources.release(agent.id, paseo, mode, closeLocalResources),
    };
    const phaseWork = createPhaseWorkService();
    const rootPullRequest = createRootPullRequestService();
    const changeFindingResolution = createChangeFindingResolutionService({ ...agentLifecycle, phaseWork });
    const implementationFindingResolution = createImplementationFindingResolutionService({
      ...agentLifecycle,
      phaseWork,
    });
    const workflow = createOpenSpecWorkflow({
      workspaceDirectory,
      readAgentProfiles,
      gitBranch: (directory, signal) => readGitBranch(directory, { signal }),
      gitWorktree: (directory, signal) => readGitWorktreeStatus(directory, { signal }),
      miseToolchain: inspectMiseToolchain,
      changeInitialization: createChangeInitializationService(),
      planningBranch: createPlanningBranchService(),
      implementationBranch: createImplementationBranchService(),
      implementationReview: createImplementationReviewService({ ...agentLifecycle, phaseWork }),
      implementationRunVerification: createImplementationRunVerifier(),
      verifyChange: verifyOpenSpecChange,
      changeArtifacts: createChangeArtifactCreationService(agentLifecycle),
      changePublication: createChangePublicationService(agentLifecycle),
      changeReview: createChangeReviewService({ ...agentLifecycle, phaseWork }),
      changeFindingResolution,
      implementationFindingResolution,
      changeTaskExecution: createChangeTaskExecutionService(agentLifecycle),
      phaseWork,
      phaseTaskPlanning: createPhaseTaskPlanningService({ ...agentLifecycle, phaseWork }),
      rootBranch: createRootBranchService(),
      rootPullRequest,
      changeArchive: createChangeArchiveService({ ...agentLifecycle, rootPullRequest }),
    });
    this.#engine.initialize(workspaceId, {
      workspaceDisplay,
      refreshWorkspaceDisplay: async () => {
        const refreshed = await workspace.refresh();
        if (!refreshed) {
          throw new Error("Рабочая область больше недоступна");
        }
        return workspaceDisplayFromSnapshot(refreshed);
      },
      workflow: {
        ...workflow,
        steps: workflow.steps.map((step) => ({
          ...step,
          run: (context) => this.#resources.runStage(workspaceId, paseo, () => step.run(context)),
        })),
      },
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
