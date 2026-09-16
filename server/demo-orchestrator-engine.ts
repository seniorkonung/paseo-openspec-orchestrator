import type { ControlCommand, OrchestratorChange } from "../shared/orchestrator.ts";
import type { OrchestratorEngine } from "./orchestrator-engine.ts";
import { OrchestratorLedger } from "./orchestrator-ledger.ts";
import {
  createOrchestratorReporter,
  type ActionHandle,
  type OrchestratorReporter,
} from "./orchestrator-reporter.ts";

export interface DemoStep {
  text: string;
  durationMs: number;
  changeAfter?: OrchestratorChange;
}

export interface DemoOrchestratorEngineOptions {
  steps?: readonly DemoStep[];
  sleep?: (durationMs: number) => Promise<void>;
  now?: () => Date;
}

interface WorkspaceRuntime {
  generation: number;
  nextStep: number;
  pauseRequested: boolean;
  active: boolean;
  currentHandle: ActionHandle | null;
}

const DEFAULT_STEPS: readonly DemoStep[] = [
  { text: "Проверяю структуру OpenSpec", durationMs: 450 },
  {
    text: "Определяю текущий change",
    durationMs: 650,
    changeAfter: {
      id: "orchestrator-ui-demo",
      title: "Демонстрация интерфейса оркестратора",
    },
  },
  { text: "Проверяю артефакты change", durationMs: 550 },
  { text: "Ожидаю завершения работы исполнителя", durationMs: 5_500 },
  { text: "Фиксирую итоговое состояние change", durationMs: 700 },
];

const defaultSleep = (durationMs: number) =>
  new Promise<void>((resolveSleep) => setTimeout(resolveSleep, durationMs));

export class DemoOrchestratorEngine implements OrchestratorEngine {
  readonly #ledger: OrchestratorLedger;
  readonly #steps: readonly DemoStep[];
  readonly #sleep: (durationMs: number) => Promise<void>;
  readonly #now: () => Date;
  readonly #runtime = new Map<string, WorkspaceRuntime>();
  #disposed = false;

  constructor(ledger: OrchestratorLedger, options: DemoOrchestratorEngineOptions = {}) {
    this.#ledger = ledger;
    this.#steps = options.steps ?? DEFAULT_STEPS;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? (() => new Date());
  }

  initialize(workspaceId: string): void {
    if (this.#runtime.has(workspaceId)) return;

    const snapshot = this.#ledger.get(workspaceId);
    const interrupted = snapshot.currentAction !== null;
    const cannotContinue = ["starting", "running", "pausing", "paused"].includes(
      snapshot.lifecycle.status,
    );
    if (interrupted || cannotContinue) {
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

    this.#runtime.set(workspaceId, {
      generation: 0,
      nextStep: 0,
      pauseRequested: false,
      active: false,
      currentHandle: null,
    });
  }

  command(workspaceId: string, command: ControlCommand): void {
    if (this.#disposed) throw new Error("Демонстрационный движок остановлен");
    this.initialize(workspaceId);
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
      if (runtime.currentHandle) {
        try {
          runtime.currentHandle.cancel();
        } catch {
          // Состояние уже могло завершиться между тиками event loop.
        }
        runtime.currentHandle = null;
      }

      const snapshot = this.#ledger.get(workspaceId);
      if (["starting", "running", "pausing", "paused"].includes(snapshot.lifecycle.status)) {
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
    runtime.nextStep = 0;
    runtime.pauseRequested = false;
    runtime.active = true;
    runtime.currentHandle = null;
    reporter.setChange(null);
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
    try {
      while (
        !this.#disposed &&
        runtime.generation === generation &&
        runtime.nextStep < this.#steps.length
      ) {
        if (runtime.pauseRequested) {
          this.#reachPause(reporter, runtime);
          return;
        }

        const step = this.#steps[runtime.nextStep];
        if (!step) break;
        const handle = reporter.beginAction({ text: step.text });
        runtime.currentHandle = handle;
        await this.#sleep(step.durationMs);

        if (this.#disposed || runtime.generation !== generation) return;
        handle.succeed();
        runtime.currentHandle = null;
        runtime.nextStep += 1;
        if (step.changeAfter) reporter.setChange(step.changeAfter);
        if (runtime.pauseRequested) {
          this.#reachPause(reporter, runtime);
          return;
        }
      }

      if (this.#disposed || runtime.generation !== generation) return;
      runtime.active = false;
      reporter.setLifecycle({ status: "completed", availableCommand: "start" });
    } catch (error) {
      runtime.active = false;
      if (runtime.currentHandle) {
        try {
          runtime.currentHandle.fail();
        } catch {
          // Ошибка handle не должна скрывать исходную ошибку сценария.
        }
        runtime.currentHandle = null;
      }
      if (!this.#disposed && runtime.generation === generation) {
        reporter.setLifecycle({
          status: "failed",
          availableCommand: "retry",
          message: "Демонстрационный сценарий завершился ошибкой",
        });
        console.error("[OpenSpec] Ошибка демонстрационного оркестратора", {
          workspaceId,
          error,
        });
      }
    }
  }

  #reachPause(reporter: OrchestratorReporter, runtime: WorkspaceRuntime): void {
    runtime.active = false;
    reporter.setLifecycle({ status: "paused", availableCommand: "resume" });
  }

  #requireRuntime(workspaceId: string): WorkspaceRuntime {
    const runtime = this.#runtime.get(workspaceId);
    if (!runtime) throw new Error("Демонстрационный движок не инициализирован");
    return runtime;
  }
}
