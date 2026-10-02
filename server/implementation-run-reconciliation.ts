import {
  implementationRunSchema,
  type ImplementationBatch,
  type ImplementationRun,
  type ImplementationTaskCommit,
} from "./implementation-run-model.ts";
import { taskTitle } from "./phase-progress-adoption.ts";
import type { PhaseProgress, PhaseTaskSnapshot } from "./phase-work.ts";

export interface ImplementationRunReanchoringInput {
  readonly run: ImplementationRun;
  /**
   * Baseline задач до принятия изменений списка. По нему опознаются задачи,
   * записанные в пакет под прежними ID и номерами.
   */
  readonly previousBaseline: PhaseProgress;
  /**
   * Baseline задач, соответствующий текущему списку: его задачи образуют
   * префикс `tasks`, а отметка `done` означает «завершена до начала пакета».
   */
  readonly baseline: PhaseProgress;
  /** Текущий список задач change. */
  readonly tasks: readonly PhaseTaskSnapshot[];
  /** Текущий Git HEAD корневой ветки. */
  readonly head: string;
  /**
   * Ближайший к коммиту коммит текущей истории: сам коммит, пока он остаётся
   * предком HEAD, общий предок после переписывания истории либо `null`.
   */
  readonly nearestAncestor: (commit: string) => string | null;
}

export interface ImplementationRunReanchoring {
  readonly run: ImplementationRun;
  /**
   * Что изменилось в run. Заметки есть тогда и только тогда, когда run
   * отличается от переданного.
   */
  readonly notes: readonly string[];
}

/**
 * Приводит implementation run к фактической истории и списку задач.
 *
 * Открытый пакет review определяется репозиторием: он начинается с сохранённого
 * baseline, заканчивается текущим HEAD и содержит задачи фазы, завершённые
 * после начала пакета. Поэтому посторонние коммиты, перестановка задач и
 * задачи, завершённые вне task-сессии, не выводят их изменения из-под
 * implementation review.
 *
 * Проверенный пакет — запись о выполненном review: он ждёт только устранения
 * findings, после которого следующий пакет начинается от текущего HEAD. Его
 * границы с историей больше не сверяются и поэтому не переносятся.
 *
 * Функция чистая: факты истории передаются через `nearestAncestor`.
 */
export function reanchorImplementationRun(
  input: ImplementationRunReanchoringInput,
): ImplementationRunReanchoring {
  const run = implementationRunSchema.parse(input.run);
  const notes: string[] = [];
  const rootBaselineCommit = input.nearestAncestor(run.rootBaselineCommit) ?? input.head;
  if (rootBaselineCommit !== run.rootBaselineCommit) {
    notes.push("baseline run перенесён на общий предок с текущей историей");
  }
  const batch = run.batch.kind === "reviewed"
    ? run.batch
    : reanchorOpenBatch(run.batch, run.phaseNumber, rootBaselineCommit, input, notes);
  return {
    run: implementationRunSchema.parse({ ...run, rootBaselineCommit, batch }),
    notes,
  };
}

function reanchorOpenBatch(
  batch: Exclude<ImplementationBatch, { kind: "reviewed" }>,
  phaseNumber: number,
  rootBaselineCommit: string,
  input: ImplementationRunReanchoringInput,
  notes: string[],
): ImplementationBatch {
  const baseCommit = input.nearestAncestor(batch.baseCommit) ?? rootBaselineCommit;
  if (baseCommit !== batch.baseCommit) {
    notes.push("baseline пакета перенесён на общий предок с текущей историей");
  }

  const recorded = batch.kind === "collecting" ? batch.tasks : [];
  const baselineById = new Map(input.baseline.tasks.map((task) => [task.id, task]));
  const completedInBatch = (task: PhaseTaskSnapshot): boolean =>
    task.phaseNumber === phaseNumber && task.done && !(baselineById.get(task.id)?.done ?? false);

  const kept: ImplementationTaskCommit[] = [];
  const dropped: string[] = [];
  const unbounded: string[] = [];
  let renumbered = false;
  for (const task of recorded) {
    const current = resolveRecordedTask(task, input);
    if (!current || !completedInBatch(current)) {
      dropped.push(task.taskNumber);
      continue;
    }
    const commit = task.commit !== null && input.nearestAncestor(task.commit) === task.commit
      ? task.commit
      : null;
    if (task.commit !== null && commit === null) unbounded.push(current.number);
    if (current.id !== task.taskId || current.number !== task.taskNumber) renumbered = true;
    kept.push({ taskId: current.id, taskNumber: current.number, commit });
  }
  const keptIds = new Set(kept.map(({ taskId }) => taskId));
  // Задачи вне task-сессий идут после записанных, в порядке файла задач.
  const outside = input.tasks
    .filter((task) => completedInBatch(task) && !keptIds.has(task.id))
    .map((task): ImplementationTaskCommit => ({
      taskId: task.id,
      taskNumber: task.number,
      commit: null,
    }));
  const tasks = [...kept, ...outside];
  const droppedNote =
    `из пакета исключены задачи, которых нет среди завершённых задач фазы: ${dropped.join(", ")}`;

  // Пакет без задач или без коммитов после baseline проверять нечем. Задачи,
  // которые остаются завершёнными, вернутся в него со следующим коммитом.
  if (tasks.length === 0 || input.head === baseCommit) {
    if (dropped.length > 0) notes.push(droppedNote);
    else if (batch.kind === "collecting") {
      notes.push("пакет implementation опустошён: после его baseline не осталось коммитов");
    }
    return { kind: "empty", baseCommit };
  }

  if (renumbered) notes.push("задачи пакета сопоставлены с изменённым списком задач");
  if (dropped.length > 0) notes.push(droppedNote);
  if (unbounded.length > 0) {
    notes.push(`завершающие коммиты задач ${unbounded.join(", ")} исчезли из истории`);
  }
  if (outside.length > 0) {
    notes.push(
      `в пакет добавлены задачи, завершённые вне task-сессии: ${outside.map(({ taskNumber }) => taskNumber).join(", ")}`,
    );
  }
  if (batch.kind === "collecting" && batch.headCommit !== input.head) {
    notes.push("пакет implementation продолжен до текущего HEAD");
  }
  return { kind: "collecting", baseCommit, headCommit: input.head, tasks };
}

/**
 * Находит записанную в пакет задачу в текущем списке. Позиция и номер задачи
 * меняются при перестановке, поэтому задача опознаётся по описанию, которое
 * она имела в baseline, а после перенумерации — по однозначному тексту без
 * номера.
 */
function resolveRecordedTask(
  task: ImplementationTaskCommit,
  input: ImplementationRunReanchoringInput,
): PhaseTaskSnapshot | null {
  const samePlace = input.tasks.find(
    ({ id, number }) => id === task.taskId && number === task.taskNumber,
  );
  const known = input.previousBaseline.tasks.find(
    ({ id, number }) => id === task.taskId && number === task.taskNumber,
  );
  if (!known) return samePlace ?? null;
  if (samePlace?.description === known.description) return samePlace;
  const byDescription = input.tasks.filter(({ description }) => description === known.description);
  if (byDescription.length === 1) return byDescription[0]!;
  const title = taskTitle(known.description);
  const byTitle = input.tasks.filter(({ description }) => taskTitle(description) === title);
  return byTitle.length === 1 ? byTitle[0]! : null;
}
