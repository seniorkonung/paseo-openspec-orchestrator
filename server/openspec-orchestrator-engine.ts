import {
  ORCHESTRATOR_LIMITS,
  type ControlCommand,
} from "../shared/orchestrator.ts";
import {
  normalizeOrchestratorWorkspaceDisplay,
  type OrchestratorNotificationRequest,
  type OrchestratorWorkspaceDisplay,
} from "../shared/orchestrator-notifications.ts";
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
  workflowCheckpointSchema,
  workflowStateSchema,
  type WorkflowCheckpoint,
  type WorkflowDefinition,
  type WorkflowState,
  type WorkflowStepDefinition,
  type WorkflowStepId,
} from "./workflow/types.ts";

export interface OpenSpecOrchestratorEngineOptions {
  notifications?: OrchestratorNotificationSink;
  steps?: readonly WorkflowStepDefinition[];
  startStepId?: WorkflowStepId;
  now?: () => Date;
}

interface WorkspaceRuntime {
  workflow: PreparedWorkflow;
  workspaceDisplay: OrchestratorWorkspaceDisplay;
  refreshWorkspaceDisplay: () => Promise<OrchestratorWorkspaceDisplay>;
  generation: number;
  pauseRequested: boolean;
  active: boolean;
  currentStepId: WorkflowStepId | null;
  state: WorkflowState;
  durableCheckpoint: WorkflowCheckpoint | null;
  currentHandle: ActionHandle | null;
  abortController: AbortController | null;
}

interface PreparedWorkflow {
  readonly startStepId: WorkflowStepId;
  readonly steps: ReadonlyMap<WorkflowStepId, WorkflowStepDefinition>;
}

const ACTIVE_LIFECYCLE_STATUSES = ["starting", "running", "pausing", "paused"] as const;
const MAX_STEP_LABEL_LENGTH = ORCHESTRATOR_LIMITS.actionText;

function isActiveLifecycleStatus(status: string): boolean {
  return (ACTIVE_LIFECYCLE_STATUSES as readonly string[]).includes(status);
}

function cloneCheckpoint(checkpoint: WorkflowCheckpoint | null): WorkflowCheckpoint | null {
  return checkpoint ? workflowCheckpointSchema.parse(checkpoint) : null;
}

function checkpointFor(stepId: WorkflowStepId, state: WorkflowState): WorkflowCheckpoint {
  return workflowCheckpointSchema.parse({
    version: 3,
    nextStepId: stepId,
    state,
  });
}

function prepareWorkflow(definition: WorkflowDefinition): PreparedWorkflow {
  const configuredSteps = [...definition.steps];
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
  if (!steps.has(definition.startStepId)) {
    throw new Error(`Начальный шаг workflow не найден: ${definition.startStepId}`);
  }
  return { startStepId: definition.startStepId, steps };
}

export class OpenSpecOrchestratorEngine implements OrchestratorEngine {
  readonly #ledger: OrchestratorLedger;
  readonly #notifications: OrchestratorNotificationSink;
  readonly #workflowOverride: PreparedWorkflow | null;
  readonly #startStepIdOverride: WorkflowStepId | null;
  readonly #now: () => Date;
  readonly #runtime = new Map<string, WorkspaceRuntime>();
  readonly #activeRuns = new Set<Promise<void>>();
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(ledger: OrchestratorLedger, options: OpenSpecOrchestratorEngineOptions = {}) {
    this.#ledger = ledger;
    this.#notifications = options.notifications ?? new NoopOrchestratorNotificationSink();
    this.#workflowOverride = options.steps
      ? prepareWorkflow({
          startStepId: options.startStepId ?? options.steps[0]?.id ?? "",
          steps: options.steps,
        })
      : null;
    this.#startStepIdOverride = options.startStepId ?? null;
    this.#now = options.now ?? (() => new Date());
  }

  initialize(workspaceId: string, context: OrchestratorEngineContext): void {
    if (this.#runtime.has(workspaceId)) return;
    this.#recoverInterruptedRun(workspaceId);
    const checkpoint = this.#ledger.getWorkflowCheckpoint(workspaceId);
    const workflow =
      this.#workflowOverride ??
      prepareWorkflow({
        ...context.workflow,
        startStepId: this.#startStepIdOverride ?? context.workflow.startStepId,
      });
    this.#runtime.set(workspaceId, {
      workflow,
      workspaceDisplay: normalizeOrchestratorWorkspaceDisplay(context.workspaceDisplay),
      refreshWorkspaceDisplay: context.refreshWorkspaceDisplay,
      generation: 0,
      pauseRequested: false,
      active: false,
      currentStepId: checkpoint?.nextStepId ?? null,
      state: checkpoint?.state ?? createInitialWorkflowState(),
      durableCheckpoint: cloneCheckpoint(checkpoint),
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
        this.#beginRun(workspaceId, runtime, reporter);
        break;
      case "retry":
        this.#beginRun(workspaceId, runtime, reporter);
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

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
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
    this.#disposePromise = Promise.allSettled([...this.#activeRuns]).then((results) => {
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) {
        console.error("[OpenSpec] Ошибка при остановке активных workflow", {
          failures,
        });
      }
    });
    return this.#disposePromise;
  }

  #beginRun(
    workspaceId: string,
    runtime: WorkspaceRuntime,
    reporter: OrchestratorReporter,
  ): void {
    runtime.generation += 1;
    runtime.pauseRequested = false;
    runtime.active = true;
    const durableCheckpoint = cloneCheckpoint(runtime.durableCheckpoint);
    if (durableCheckpoint) {
      runtime.currentStepId = durableCheckpoint.nextStepId;
      runtime.state = durableCheckpoint.state;
    } else {
      runtime.currentStepId = runtime.workflow.startStepId;
      runtime.state = createInitialWorkflowState();
      reporter.setChange(null);
    }
    runtime.currentHandle = null;
    runtime.abortController?.abort();
    runtime.abortController = new AbortController();
    reporter.setLifecycle({ status: "starting", availableCommand: null });
    const generation = runtime.generation;
    const prepareCheckpoint = durableCheckpoint
      ? Promise.resolve(true)
      : this.#saveCheckpoint(
          workspaceId,
          runtime,
          reporter,
          generation,
          checkpointFor(runtime.workflow.startStepId, runtime.state),
        );

    queueMicrotask(() => {
      void prepareCheckpoint
        .then((prepared) => {
          if (!prepared || this.#disposed || runtime.generation !== generation) return;
          reporter.setLifecycle({ status: "running", availableCommand: "pause" });
          this.#trackRun(this.#run(workspaceId, runtime, reporter, generation));
        })
        .catch((error) => {
          if (this.#disposed || runtime.generation !== generation) return;
          console.error("[OpenSpec] Не удалось подготовить запуск workflow", {
            workspaceId,
            error,
          });
          this.#fail(
            workspaceId,
            reporter,
            runtime,
            "Не удалось подготовить состояние workflow; проверьте диск и нажмите «Повторить»",
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
      if (this.#disposed || runtime.generation !== generation) return;
      this.#trackRun(this.#run(workspaceId, runtime, reporter, generation));
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
      const step = runtime.workflow.steps.get(currentStepId);
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
          signal: abortController.signal,
          state: runtime.state,
          updateActionLinks: (links) => {
            if (this.#disposed || runtime.generation !== generation) {
              throw new Error("Workflow больше не принимает ссылки действий");
            }
            handle.update({ links: [...links] });
          },
          checkpointState: (nextState) =>
            this.#checkpointState(
              workspaceId,
              runtime,
              reporter,
              generation,
              currentStepId,
              nextState,
            ),
          notify: (notification) => this.#notify(workspaceId, notification, runtime),
        });
        if (this.#disposed || runtime.generation !== generation) return;

        handle.update({ text: result.summary ?? step.label });

        switch (result.kind) {
          case "halt":
            this.#fail(workspaceId, reporter, runtime, result.message);
            return;
          case "complete": {
            const nextState = workflowStateSchema.parse({
              ...runtime.state,
              ...(result.state ?? {}),
            });
            if (!(await this.#saveCheckpoint(workspaceId, runtime, reporter, generation, null))) return;
            if (this.#disposed || runtime.generation !== generation) return;
            runtime.state = nextState;
            runtime.currentStepId = null;
            handle.succeed();
            runtime.currentHandle = null;
            this.#complete(workspaceId, reporter, runtime);
            return;
          }
          case "continue": {
            if (!runtime.workflow.steps.has(result.next)) {
              this.#fail(
                workspaceId,
                reporter,
                runtime,
                `Следующий шаг «${result.next}» не найден; проверьте конфигурацию workflow и нажмите «Повторить»`,
              );
              return;
            }
            const nextState = workflowStateSchema.parse({
              ...runtime.state,
              ...(result.state ?? {}),
            });
            if (
              !(await this.#saveCheckpoint(
                workspaceId,
                runtime,
                reporter,
                generation,
                checkpointFor(result.next, nextState),
              ))
            ) {
              return;
            }
            if (this.#disposed || runtime.generation !== generation) return;
            runtime.state = nextState;
            runtime.currentStepId = result.next;
            handle.succeed();
            runtime.currentHandle = null;
            if (runtime.pauseRequested) {
              this.#reachPause(reporter, runtime);
              return;
            }
            break;
          }
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
    reporter.setLifecycle({ status: "completed", availableCommand: "start" });
    this.#notify(
      workspaceId,
      {
        kind: "completed",
        message: "Все действия текущего запуска завершены",
      },
      runtime,
    );
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
    this.#notify(workspaceId, { kind: "retry", message }, runtime);
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
    runtime.durableCheckpoint = null;
    this.#ledger.clear(workspaceId);
  }

  async #saveCheckpoint(
    workspaceId: string,
    runtime: WorkspaceRuntime,
    reporter: OrchestratorReporter,
    generation: number,
    checkpoint: WorkflowCheckpoint | null,
  ): Promise<boolean> {
    try {
      return await this.#writeCheckpoint(workspaceId, runtime, generation, checkpoint);
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

  async #writeCheckpoint(
    workspaceId: string,
    runtime: WorkspaceRuntime,
    generation: number,
    checkpoint: WorkflowCheckpoint | null,
  ): Promise<boolean> {
    const previousCheckpoint = cloneCheckpoint(runtime.durableCheckpoint);
    try {
      await this.#ledger.saveWorkflowCheckpoint(workspaceId, checkpoint);
    } catch (error) {
      this.#ledger.setWorkflowCheckpoint(workspaceId, previousCheckpoint);
      throw error;
    }
    if (this.#disposed || runtime.generation !== generation) return false;
    runtime.durableCheckpoint = cloneCheckpoint(checkpoint);
    return true;
  }

  async #checkpointState(
    workspaceId: string,
    runtime: WorkspaceRuntime,
    reporter: OrchestratorReporter,
    generation: number,
    stepId: WorkflowStepId,
    requestedState: WorkflowState,
  ): Promise<void> {
    if (
      this.#disposed ||
      runtime.generation !== generation ||
      runtime.currentStepId !== stepId ||
      runtime.abortController?.signal.aborted
    ) {
      throw new Error("Workflow больше не принимает обновление состояния");
    }

    const previousChange = this.#ledger.get(workspaceId).change;
    const nextState = workflowStateSchema.parse(requestedState);
    const publicChangeChanged = previousChange?.id !== nextState.change?.id;
    const saved = await this.#writeCheckpoint(
      workspaceId,
      runtime,
      generation,
      checkpointFor(stepId, nextState),
    );
    if (!saved) {
      throw new Error("Workflow больше не принимает обновление состояния");
    }
    runtime.state = nextState;
    if (publicChangeChanged) reporter.setChange(nextState.change);
  }

  #trackRun(run: Promise<void>): void {
    this.#activeRuns.add(run);
    void run.finally(() => this.#activeRuns.delete(run)).catch((error) => {
      console.error("[OpenSpec] Непредвиденная ошибка выполнения workflow", { error });
    });
  }

  async #notify(
    workspaceId: string,
    notification: OrchestratorNotificationRequest,
    runtime: WorkspaceRuntime,
  ): Promise<boolean> {
    let workspace = runtime.workspaceDisplay;
    try {
      workspace = normalizeOrchestratorWorkspaceDisplay(
        await runtime.refreshWorkspaceDisplay(),
      );
      runtime.workspaceDisplay = workspace;
    } catch (error) {
      console.warn("[OpenSpec] Не удалось обновить название workspace для уведомления", {
        workspaceId,
        error,
      });
    }

    return this.#notifications.notify(workspaceId, notification, workspace).catch((error) => {
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
