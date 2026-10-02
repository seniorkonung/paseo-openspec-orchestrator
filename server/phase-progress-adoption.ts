import {
  describeTaskHistoryViolation,
  describeTaskScopeViolation,
  phaseProgressSchema,
  type PhaseProgress,
  type PhaseTaskSnapshot,
  type PhaseWorkSnapshot,
} from "./phase-work.ts";
import { planningRunSchema, type PlanningRun } from "./planning-run-model.ts";

/**
 * Принятие списка задач, изменённого вне контракта этапа.
 *
 * Сохранённый baseline задач нужен, чтобы проверить работу одного агентского
 * этапа. Когда репозиторий расходится с baseline до начала этапа, расхождение
 * внёс не этот этап: его нельзя исправить продолжением workflow, поэтому
 * baseline переносится на фактический список задач. Функции модуля чистые и
 * не читают репозиторий.
 */

const TASK_NUMBER_PREFIX = /^\d+(?:\.\d+)+[A-Za-z]*\s+/u;

type TaskSnapshot = Pick<PhaseWorkSnapshot, "phases" | "tasks">;

/** Baseline принят без изменений либо перенесён на текущий список задач. */
export interface BaselineAdoption<Baseline> {
  readonly baseline: Baseline;
  /** Чем прежний baseline противоречил репозиторию; `null` — не противоречил. */
  readonly violation: string | null;
}

export type PlanningRunAdoption =
  | { readonly kind: "kept" }
  | { readonly kind: "rebased"; readonly run: PlanningRun; readonly violation: string }
  /** Планирование фазы потеряло смысл: его нельзя выразить новым baseline. */
  | { readonly kind: "void"; readonly violation: string };

/**
 * Baseline implementation run. Отметка `done` в нём означает «задача была
 * завершена до начала текущего пакета», поэтому при переносе на новый список
 * она сохраняется за той же задачей, а не берётся из текущего состояния.
 */
export function adoptImplementationBaseline(
  baseline: PhaseProgress,
  snapshot: PhaseWorkSnapshot,
  phaseNumber: number,
): BaselineAdoption<PhaseProgress> {
  const violation =
    describeTaskHistoryViolation(snapshot.tasks, baseline) ??
    describeTaskScopeViolation(snapshot, { kind: "implementation", phaseNumber, baseline });
  return violation === null
    ? { baseline, violation }
    : { baseline: rebasePhaseProgress(baseline, snapshot), violation };
}

/**
 * Baseline между run: история задач до следующей проверки фаз. Нарушенная
 * история заменяется текущим списком с его фактическими отметками.
 */
export function adoptPhaseProgress(
  baseline: PhaseProgress,
  snapshot: TaskSnapshot,
): BaselineAdoption<PhaseProgress> {
  const violation = describeTaskHistoryViolation(snapshot.tasks, baseline);
  return violation === null
    ? { baseline, violation }
    : { baseline: progressOf(snapshot, baseline.nextImplementationRun), violation };
}

/** Фазы с задачами начального планирования: нарушение заменяет их текущими. */
export function adoptInitialPlannedPhases(
  plannedPhases: readonly number[],
  snapshot: PhaseWorkSnapshot,
): BaselineAdoption<readonly number[]> {
  const violation = describeTaskScopeViolation(snapshot, {
    kind: "initial-planning",
    plannedPhases,
  });
  if (violation === null) return { baseline: plannedPhases, violation };
  const withTasks = new Set(snapshot.tasks.map(({ phaseNumber }) => phaseNumber));
  return {
    baseline: snapshot.phases.map(({ number }) => number).filter((number) => withTasks.has(number)),
    violation,
  };
}

/**
 * Baseline планирования фазы — завершённые задачи предыдущих фаз. Он переносится
 * на текущий список, пока задачи вне целевой фазы остаются завершённым
 * префиксом, а задачи самой фазы ещё не начаты. Иначе в change появилась
 * работа, которую планированием фазы не выразить, и planning run аннулируется.
 */
export function adoptPlanningRun(run: PlanningRun, snapshot: PhaseWorkSnapshot): PlanningRunAdoption {
  const violation = describePlanningRunViolation(run, snapshot);
  if (violation === null) return { kind: "kept" };

  const outside = snapshot.tasks.filter(({ phaseNumber }) => phaseNumber !== run.phaseNumber);
  const precedesPhaseTasks = outside.every((task, index) => snapshot.tasks[index] === task);
  if (!precedesPhaseTasks) return { kind: "void", violation };
  const rebased = planningRunSchema.safeParse({
    ...run,
    baselineProgress: progressOf(
      { phases: snapshot.phases, tasks: outside },
      run.baselineProgress.nextImplementationRun,
    ),
  });
  // Перенос обязан снять нарушение: уже завершённую задачу целевой фазы новым
  // baseline не выразить, и планирование повторяло бы ту же остановку.
  return rebased.success && describePlanningRunViolation(rebased.data, snapshot) === null
    ? { kind: "rebased", run: rebased.data, violation }
    : { kind: "void", violation };
}

function describePlanningRunViolation(run: PlanningRun, snapshot: PhaseWorkSnapshot): string | null {
  return (
    describeTaskHistoryViolation(snapshot.tasks, run.baselineProgress) ??
    describeTaskScopeViolation(snapshot, {
      kind: "phase-planning",
      phaseNumber: run.phaseNumber,
      baseline: run.baselineProgress,
    })
  );
}

/**
 * Переносит baseline на текущий список задач. Задача сопоставляется с прежней
 * по полному описанию, а после перенумерации — по тексту без номера, если он
 * однозначен. Несопоставленная задача считается незавершённой на начало пакета.
 */
export function rebasePhaseProgress(
  baseline: PhaseProgress,
  snapshot: TaskSnapshot,
): PhaseProgress {
  const byDescription = new Map(baseline.tasks.map((task) => [task.description, task]));
  const currentDescriptions = new Set(snapshot.tasks.map(({ description }) => description));
  const renumberedBaseline = uniqueByTitle(
    baseline.tasks.filter(({ description }) => !currentDescriptions.has(description)),
  );
  const renumberedCurrent = uniqueByTitle(
    snapshot.tasks.filter(({ description }) => !byDescription.has(description)),
  );
  return phaseProgressSchema.parse({
    phases: snapshot.phases.map(({ number }) => ({ number })),
    tasks: snapshot.tasks.map((task) => {
      const title = taskTitle(task.description);
      const known =
        byDescription.get(task.description) ??
        (renumberedCurrent.has(title) ? renumberedBaseline.get(title) : undefined);
      return {
        id: task.id,
        number: task.number,
        description: task.description,
        done: task.done && (known?.done ?? false),
        fingerprint: task.fingerprint,
      };
    }),
    nextImplementationRun: baseline.nextImplementationRun,
  });
}

/** Текст задачи без номера: он не меняется при перенумерации. */
export function taskTitle(description: string): string {
  return description.replace(TASK_NUMBER_PREFIX, "").trim();
}

function progressOf(snapshot: TaskSnapshot, nextImplementationRun: number): PhaseProgress {
  return phaseProgressSchema.parse({
    phases: snapshot.phases.map(({ number }) => ({ number })),
    tasks: snapshot.tasks.map(toProgressTask),
    nextImplementationRun,
  });
}

function toProgressTask(task: PhaseTaskSnapshot): PhaseProgress["tasks"][number] {
  return {
    id: task.id,
    number: task.number,
    description: task.description,
    done: task.done,
    fingerprint: task.fingerprint,
  };
}

/** Задачи, чей текст без номера встречается среди переданных ровно один раз. */
function uniqueByTitle<Task extends { readonly description: string }>(
  tasks: readonly Task[],
): ReadonlyMap<string, Task> {
  const counts = new Map<string, number>();
  for (const { description } of tasks) {
    const title = taskTitle(description);
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return new Map(
    tasks
      .map((task) => [taskTitle(task.description), task] as const)
      .filter(([title]) => counts.get(title) === 1),
  );
}
