import type { ControlCommand } from "../shared/orchestrator.ts";
import { readGitBranch, type GitBranchProbe } from "./git-branch.ts";
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
} from "./workflow/types.ts";
import { OPEN_SPEC_WORKFLOW_STEPS } from "./workflow/steps/index.ts";

export interface OpenSpecOrchestratorEngineOptions {
  branchProbe?: GitBranchProbe;
  steps?: readonly WorkflowStepDefinition[];
  now?: () => Date;
}

interface WorkspaceRuntime {
  workspaceDirectory: string;
  generation: number;
  pauseRequested: boolean;
  active: boolean;
  nextStep: number;
  state: WorkflowState;
  currentHandle: ActionHandle | null;
  abortController: AbortController | null;
}

const ACTIVE_LIFECYCLE_STATUSES = ["starting", "running", "pausing", "paused"] as const;

function isActiveLifecycleStatus(status: string): boolean {
  return (ACTIVE_LIFECYCLE_STATUSES as readonly string[]).includes(status);
}

export class OpenSpecOrchestratorEngine implements OrchestratorEngine {
  readonly #ledger: OrchestratorLedger;
  readonly #branchProbe: GitBranchProbe;
  readonly #steps: readonly WorkflowStepDefinition[];
  readonly #now: () => Date;
  readonly #runtime = new Map<string, WorkspaceRuntime>();
  #disposed = false;

  constructor(ledger: OrchestratorLedger, options: OpenSpecOrchestratorEngineOptions = {}) {
    this.#ledger = ledger;
    this.#branchProbe =
      options.branchProbe ??
      ((workspaceDirectory, signal) => readGitBranch(workspaceDirectory, { signal }));
    this.#steps = Object.freeze([...(options.steps ?? OPEN_SPEC_WORKFLOW_STEPS)]);
    if (this.#steps.length === 0) {
      throw new Error("Workflow должен содержать хотя бы один шаг");
    }
    this.#now = options.now ?? (() => new Date());
  }

  initialize(workspaceId: string, context: OrchestratorEngineContext): void {
    if (this.#runtime.has(workspaceId)) return;
    this.#recoverInterruptedRun(workspaceId);
    this.#runtime.set(workspaceId, {
      workspaceDirectory: context.workspaceDirectory,
      generation: 0,
      pauseRequested: false,
      active: false,
      nextStep: 0,
      state: createInitialWorkflowState(),
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
      case "retry":
        this.#start(workspaceId, runtime, reporter);
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
  ): void {
    runtime.generation += 1;
    runtime.pauseRequested = false;
    runtime.active = true;
    runtime.nextStep = 0;
    runtime.state = createInitialWorkflowState();
    runtime.currentHandle = null;
    runtime.abortController?.abort();
    runtime.abortController = new AbortController();
    reporter.setLifecycle({ status: "starting", availableCommand: null });
    const generation = runtime.generation;

    queueMicrotask(() => {
      if (this.#disposed || runtime.generation !== generation) return;
      reporter.setLifecycle({ status: "running", availableCommand: "pause" });
      void this.#run(workspaceId, runtime, reporter, generation);
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

      const step = this.#steps[runtime.nextStep];
      if (!step) {
        this.#complete(reporter, runtime);
        return;
      }

      const handle = reporter.beginAction({ text: step.label });
      runtime.currentHandle = handle;
      const abortController = runtime.abortController;
      if (!abortController) {
        this.#fail(
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
          services: { gitBranch: this.#branchProbe },
        });
        if (this.#disposed || runtime.generation !== generation) return;

        runtime.state = { ...runtime.state, ...(result.state ?? {}) };
        handle.update({ text: result.summary ?? step.label });
        if (result.kind === "halt") {
          this.#fail(reporter, runtime, result.message);
          return;
        }

        handle.succeed();
        runtime.currentHandle = null;
        runtime.nextStep += 1;
        if (runtime.pauseRequested) {
          this.#reachPause(reporter, runtime);
          return;
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
        this.#fail(reporter, runtime, `Шаг «${step.label}» завершился ошибкой; нажмите «Повторить»`);
        return;
      }
    }
  }

  #complete(reporter: OrchestratorReporter, runtime: WorkspaceRuntime): void {
    runtime.active = false;
    runtime.abortController = null;
    reporter.setLifecycle({ status: "completed", availableCommand: "start" });
  }

  #fail(reporter: OrchestratorReporter, runtime: WorkspaceRuntime, message: string): void {
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
  }

  #reachPause(reporter: OrchestratorReporter, runtime: WorkspaceRuntime): void {
    runtime.active = false;
    runtime.abortController = null;
    reporter.setLifecycle({ status: "paused", availableCommand: "resume" });
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
