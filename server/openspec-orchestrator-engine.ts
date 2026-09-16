import { ORCHESTRATOR_LIMITS, type ControlCommand } from "../shared/orchestrator.ts";
import type { OrchestratorNotificationRequest } from "../shared/orchestrator-notifications.ts";
import { readGitBranch, type GitBranchProbe } from "./git-branch.ts";
import { readGitWorktreeStatus, type GitWorktreeProbe } from "./git-worktree.ts";
import {
  NoopOrchestratorNotificationSink,
  type OrchestratorNotificationSink,
} from "./orchestrator-notifications.ts";
import type { OrchestratorEngine, OrchestratorEngineContext } from "./orchestrator-engine.ts";
import { OrchestratorLedger } from "./orchestrator-ledger.ts";
import {
  createOrchestratorReporter,
  type ActionHandle,
  type OrchestratorReporter,
} from "./orchestrator-reporter.ts";
import {
  createInitialWorkflowState,
  type WorkflowState,
  type WorkflowStepDefinition,
  type WorkflowStepId,
} from "./workflow/types.ts";
import { OPEN_SPEC_WORKFLOW_STEPS } from "./workflow/steps/index.ts";

export interface OpenSpecOrchestratorEngineOptions {
  branchProbe?: GitBranchProbe;
  worktreeProbe?: GitWorktreeProbe;
  notifications?: OrchestratorNotificationSink;
  steps?: readonly WorkflowStepDefinition[];
  startStepId?: WorkflowStepId;
  now?: () => Date;
}

interface WorkspaceRuntime {
  workspaceDirectory: string;
  generation: number;
  pauseRequested: boolean;
  active: boolean;
  currentStepId: WorkflowStepId | null;
  state: WorkflowState;
  resumeFromCheckpoint: boolean;
  currentHandle: ActionHandle | null;
  abortController: AbortController | null;
}

const ACTIVE_LIFECYCLE_STATUSES = ["starting", "running", "pausing", "paused"] as const;
const MAX_STEP_LABEL_LENGTH = ORCHESTRATOR_LIMITS.actionText;

function isActiveLifecycleStatus(status: string): boolean {
  return (ACTIVE_LIFECYCLE_STATUSES as readonly string[]).includes(status);
}

export class OpenSpecOrchestratorEngine implements OrchestratorEngine {
  readonly #ledger: OrchestratorLedger;
  readonly #branchProbe: GitBranchProbe;
  readonly #worktreeProbe: GitWorktreeProbe;
  readonly #notifications: OrchestratorNotificationSink;
  readonly #steps: ReadonlyMap<WorkflowStepId, WorkflowStepDefinition>;
  readonly #startStepId: WorkflowStepId;
  readonly #now: () => Date;
  readonly #runtime = new Map<string, WorkspaceRuntime>();
  #disposed = false;

  constructor(ledger: OrchestratorLedger, options: OpenSpecOrchestratorEngineOptions = {}) {
    this.#ledger = ledger;
    this.#branchProbe =
      options.branchProbe ??
      ((workspaceDirectory, signal) => readGitBranch(workspaceDirectory, { signal }));
    this.#worktreeProbe =
      options.worktreeProbe ??
      ((workspaceDirectory, signal) => readGitWorktreeStatus(workspaceDirectory, { signal }));
    this.#notifications = options.notifications ?? new NoopOrchestratorNotificationSink();
    const configuredSteps = [...(options.steps ?? OPEN_SPEC_WORKFLOW_STEPS)];
    if (configuredSteps.length === 0) {
      throw new Error("Workflow должен содержать хотя бы один шаг");
    }
    const steps = new Map<WorkflowStepId, WorkflowStepDefinition>();
    for (const step of configuredSteps) {
      if (step.id.trim().length === 0) {
        throw new Error("Workflow не может содержать шаг без id");
      }
      if (step.label.trim().length === 0 || step.label.length > MAX_STEP_LABEL_LENGTH) {
        throw new Error(`Недопустимое название шага workflow: ${step.id}`);
      }
      if (steps.has(step.id)) {
        throw new Error(`Workflow содержит повторяющийся id шага: ${step.id}`);
      }
      steps.set(step.id, step);
    }
    this.#steps = steps;
    this.#startStepId = options.startStepId ?? configuredSteps[0].id;
    if (!this.#steps.has(this.#startStepId)) {
      throw new Error(`Начальный шаг workflow не найден: ${this.#startStepId}`);
    }
    this.#now = options.now ?? (() => new Date());
  }

  initialize(workspaceId: string, context: OrchestratorEngineContext): void {
    if (this.#runtime.has(workspaceId)) return;
    this.#recoverInterruptedRun(workspaceId);
    const checkpoint = this.#ledger.getWorkflowCheckpoint(workspaceId);
    this.#runtime.set(workspaceId, {
      workspaceDirectory: context.workspaceDirectory,
      generation: 0,
      pauseRequested: false,
      active: false,
      currentStepId: checkpoint?.nextStepId ?? null,
      state: checkpoint?.state ?? createInitialWorkflowState(),
      resumeFromCheckpoint: checkpoint !== null,
      currentHandle: null,
      abortController: null,
    });
  }

  command(workspaceId: string, command: ControlCommand): void {
    if (this.#disposed) throw new Error("Workflow оркестратора остановлен");
    const runtime = this.#requireRuntime(workspaceId);
    const reporter = createOrchestratorReporter(this.#ledger, workspaceId, { now: this.#now });

    switch (command) {
      case "start":
        this.#start(workspaceId, runtime, reporter, false);
        break;
      case "retry":
        this.#start(workspaceId, runtime, reporter, true);
        break;
      case "pause":
        runtime.pauseRequested = true;
        reporter.setLifecycle({ status: "pausing", availableCommand: null });
        if (!runtime.active) this.#reachPause(reporter, runtime);
        break;
      case "resume":
        runtime.pauseRequested = false;
        runtime.active = true;
        runtime.abortController = new AbortController();
        reporter.setLifecycle({ status: "running", availableCommand: "pause" });
        this.#enqueueRun(workspaceId, runtime, reporter);
        break;
      case "clear":
        this.#clear(workspaceId, runtime);
        break;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    for (const [workspaceId, runtime] of this.#runtime) {
      runtime.generation += 1;
      runtime.active = false;
      runtime.pauseRequested = false;
      runtime.abortController?.abort();
      runtime.abortController = null;

      if (runtime.currentHandle) {
        try {
          runtime.currentHandle.cancel();
        } catch {
          // Состояние handle могло завершиться между тиками event loop.
        }
        runtime.currentHandle = null;
      }

      const snapshot = this.#ledger.get(workspaceId);
      if (isActiveLifecycleStatus(snapshot.lifecycle.status)) {
        createOrchestratorReporter(this.#ledger, workspaceId, { now: this.#now }).setLifecycle({
          status: "idle",
          availableCommand: "start",
        });
      }
    }
  }

  #start(
    workspaceId: string,
    runtime: WorkspaceRuntime,
    reporter: OrchestratorReporter,
    restart: boolean,
  ): void {
    runtime.generation += 1;
    runtime.pauseRequested = false;
    runtime.active = true;
    const useCheckpoint = !restart && runtime.resumeFromCheckpoint;
    runtime.resumeFromCheckpoint = false;
    if (!useCheckpoint) {
      runtime.currentStepId = this.#startStepId;
      runtime.state = createInitialWorkflowState();
    }
    runtime.currentHandle = null;
    runtime.abortController?.abort();
    runtime.abortController = new AbortController();
    reporter.setLifecycle({ status: "starting", availableCommand: null });
    const generation = runtime.generation;
    const checkpointReset = restart
      ? Promise.resolve().then(() => this.#ledger.saveWorkflowCheckpoint(workspaceId, null))
      : Promise.resolve();

    queueMicrotask(() => {
      void checkpointReset
        .then(() => {
          if (this.#disposed || runtime.generation !== generation) return;
          reporter.setLifecycle({ status: "running", availableCommand: "pause" });
          void this.#run(workspaceId, runtime, reporter, generation);
        })
        .catch((error) => {
          if (this.#disposed || runtime.generation !== generation) return;
          console.error("[OpenSpec] Не удалось подготовить повторный запуск workflow", {
            workspaceId,
            error,
          });
          this.#fail(
            workspaceId,
            reporter,
            runtime,
            "Не удалось очистить предыдущий checkpoint; проверьте диск и нажмите «Повторить»",
          );
        });
    });
  }

  #enqueueRun(
    workspaceId: string,
    runtime: WorkspaceRuntime,
    reporter: OrchestratorReporter,
  ): void {
    const generation = runtime.generation;
    queueMicrotask(() => {
      void this.#run(workspaceId, runtime, reporter, generation);
    });
  }

  async #run(
    workspaceId: string,
    runtime: WorkspaceRuntime,
    reporter: OrchestratorReporter,
    generation: number,
  ): Promise<void> {
    while (!this.#disposed && runtime.generation === generation) {
      if (runtime.pauseRequested) {
        this.#reachPause(reporter, runtime);
        return;
      }

      const currentStepId = runtime.currentStepId;
      if (currentStepId === null) {
        this.#complete(workspaceId, reporter, runtime);
        return;
      }
      const step = this.#steps.get(currentStepId);
      if (!step) {
        this.#fail(
          workspaceId,
          reporter,
          runtime,
          `Шаг «${currentStepId}» не найден; проверьте конфигурацию workflow и нажмите «Повторить»`,
        );
        return;
      }

      const handle = reporter.beginAction({ text: step.label });
      runtime.currentHandle = handle;
      const abortController = runtime.abortController;
      if (!abortController) {
        this.#fail(
          workspaceId,
          reporter,
          runtime,
          `Шаг «${step.label}» не может начаться; нажмите «Повторить»`,
        );
        return;
      }

      try {
        const result = await step.run({
          workspaceDirectory: runtime.workspaceDirectory,
          signal: abortController.signal,
          state: runtime.state,
          services: {
            gitBranch: this.#branchProbe,
            gitWorktree: this.#worktreeProbe,
            notify: (notification) => this.#notify(workspaceId, notification),
          },
        });
        if (this.#disposed || runtime.generation !== generation) return;

        runtime.state = { ...runtime.state, ...(result.state ?? {}) };
        handle.update({ text: result.summary ?? step.label });

        switch (result.kind) {
          case "halt":
            this.#fail(workspaceId, reporter, runtime, result.message);
            return;
          case "complete":
            handle.succeed();
            runtime.currentHandle = null;
            runtime.currentStepId = null;
            if (!(await this.#saveCheckpoint(workspaceId, runtime, reporter, generation, null))) return;
            if (this.#disposed || runtime.generation !== generation) return;
            this.#complete(workspaceId, reporter, runtime);
            return;
          case "continue":
            if (!this.#steps.has(result.next)) {
              this.#fail(
                workspaceId,
                reporter,
                runtime,
                `Следующий шаг «${result.next}» не найден; проверьте конфигурацию workflow и нажмите «Повторить»`,
              );
              return;
            }
            handle.succeed();
            runtime.currentHandle = null;
            runtime.currentStepId = result.next;
            if (
              !(await this.#saveCheckpoint(workspaceId, runtime, reporter, generation, {
                version: 1,
                nextStepId: result.next,
                state: runtime.state,
              }))
            ) {
              return;
            }
            if (this.#disposed || runtime.generation !== generation) return;
            if (runtime.pauseRequested) {
              this.#reachPause(reporter, runtime);
              return;
            }
            break;
        }
      } catch (error) {
        if (this.#disposed || runtime.generation !== generation) return;
        console.error("[OpenSpec] Ошибка шага workflow", {
          workspaceId,
          stepId: step.id,
          code:
            error && typeof error === "object" && "code" in error
              ? String(Reflect.get(error, "code"))
              : "unknown",
        });
        this.#fail(
          workspaceId,
          reporter,
          runtime,
          `Шаг «${step.label}» завершился ошибкой; нажмите «Повторить»`,
        );
        return;
      }
    }
  }

  #complete(
    workspaceId: string,
    reporter: OrchestratorReporter,
    runtime: WorkspaceRuntime,
  ): void {
    runtime.active = false;
    runtime.abortController = null;
    runtime.resumeFromCheckpoint = false;
    reporter.setLifecycle({ status: "completed", availableCommand: "start" });
    this.#notify(workspaceId, {
      kind: "completed",
      message: "Все действия текущего запуска завершены",
    });
  }

  #fail(
    workspaceId: string,
    reporter: OrchestratorReporter,
    runtime: WorkspaceRuntime,
    message: string,
  ): void {
    runtime.active = false;
    runtime.abortController = null;
    if (runtime.currentHandle) {
      try {
        runtime.currentHandle.fail();
      } catch {
        // Ошибка handle не должна скрывать исходную причину остановки workflow.
      }
      runtime.currentHandle = null;
    }
    reporter.setLifecycle({ status: "failed", availableCommand: "retry", message });
    this.#notify(workspaceId, { kind: "retry", message });
  }

  #reachPause(reporter: OrchestratorReporter, runtime: WorkspaceRuntime): void {
    runtime.active = false;
    runtime.abortController = null;
    reporter.setLifecycle({ status: "paused", availableCommand: "resume" });
  }

  #clear(workspaceId: string, runtime: WorkspaceRuntime): void {
    runtime.generation += 1;
    runtime.pauseRequested = false;
    runtime.active = false;
    runtime.abortController?.abort();
    runtime.abortController = null;
    if (runtime.currentHandle) {
      try {
        runtime.currentHandle.cancel();
      } catch {
        // Сброс должен завершиться даже если действие уже успело закрыться.
      }
      runtime.currentHandle = null;
    }
    runtime.currentStepId = null;
    runtime.state = createInitialWorkflowState();
    runtime.resumeFromCheckpoint = false;
    this.#ledger.clear(workspaceId);
  }

  async #saveCheckpoint(
    workspaceId: string,
    runtime: WorkspaceRuntime,
    reporter: OrchestratorReporter,
    generation: number,
    checkpoint: {
      version: 1;
      nextStepId: WorkflowStepId;
      state: WorkflowState;
    } | null,
  ): Promise<boolean> {
    try {
      await this.#ledger.saveWorkflowCheckpoint(workspaceId, checkpoint);
      return true;
    } catch (error) {
      if (this.#disposed || runtime.generation !== generation) return false;
      console.error("[OpenSpec] Не удалось сохранить checkpoint workflow", {
        workspaceId,
        error,
      });
      this.#fail(
        workspaceId,
        reporter,
        runtime,
        "Не удалось сохранить состояние workflow; проверьте диск и нажмите «Повторить»",
      );
      return false;
    }
  }

  #notify(
    workspaceId: string,
    notification: OrchestratorNotificationRequest,
  ): Promise<boolean> {
    return this.#notifications.notify(workspaceId, notification).catch((error) => {
      console.warn("[OpenSpec] Не удалось отправить уведомление оркестратора", {
        workspaceId,
        kind: notification.kind,
        error,
      });
      return false;
    });
  }

  #recoverInterruptedRun(workspaceId: string): void {
    const snapshot = this.#ledger.get(workspaceId);
    if (!snapshot.currentAction && !isActiveLifecycleStatus(snapshot.lifecycle.status)) return;

    this.#ledger.update(workspaceId, (projection) => {
      const history = projection.currentAction
        ? [
            ...projection.history,
            {
              ...projection.currentAction,
              finishedAt: new Date(
                Math.max(
                  this.#now().getTime(),
                  Date.parse(projection.currentAction.startedAt),
                ),
              ).toISOString(),
              outcome: "cancelled" as const,
            },
          ]
        : projection.history;
      return {
        ...projection,
        currentAction: null,
        history,
        lifecycle: { status: "idle", availableCommand: "start" },
      };
    });
  }

  #requireRuntime(workspaceId: string): WorkspaceRuntime {
    const runtime = this.#runtime.get(workspaceId);
    if (!runtime) throw new Error("Workflow оркестратора не инициализирован");
    return runtime;
  }
}
