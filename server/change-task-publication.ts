import { createHash } from "node:crypto";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import {
  assertCleanTaskWorktree as assertCleanWorktree,
  assertTaskCommitDescendsFrom as assertDescendsFrom,
  readCurrentTaskBranch as readCurrentBranch,
  readLocalTaskBranchCommit as readLocalBranchCommit,
  readRemoteTaskBranchCommit as readRemoteCommit,
  readTaskChangedPaths as readChangedPaths,
  readTaskCommitCount as readCommitCount,
  readTaskGitRoot,
  readTaskHeadCommit as readHeadCommit,
  resolveTaskRepository as resolveRepository,
} from "./change-task-gateway.ts";
import { isCommitAncestor } from "./git-ancestry.ts";
import { deliverRootCommit } from "./root-branch-delivery.ts";
import {
  ChangeTaskExecutionError,
  applyInstructionsSchema,
  pendingTaskExecutionSessionSchema,
  taskNumberSchema,
  type ApplyInstructions,
  type ApplyTask,
  type ChangeTaskExecutionPlan,
  type CompletedChangeTask,
  type PendingTaskExecutionSession,
} from "./change-task-model.ts";
import {
  implementationRunSchema,
  type ImplementationRun,
} from "./implementation-run-model.ts";
import { runWorkspaceMiseCommand } from "./mise-toolchain.ts";

const TASK_NUMBER_PREFIX = /^(\d+(?:\.\d+)+(?:[A-Za-z]+)?)(?=\s|$)/u;

/**
 * Состояние сохранённой task-сессии относительно репозитория.
 *
 * - `fresh` — работа над задачей ещё не начата;
 * - `committed` — задача реализована и закоммичена, осталось подтвердить её;
 * - `stale` — репозиторий противоречит сессии: её нельзя ни начать, ни
 *   подтвердить, и задачу нужно выбрать заново.
 */
export type TaskSessionRecovery =
  | { readonly kind: "fresh" }
  | { readonly kind: "committed" }
  | { readonly kind: "stale"; readonly reason: string };

type LocalTaskCommit =
  | { readonly kind: "verified"; readonly head: string }
  | { readonly kind: "rejected"; readonly reason: string };

export async function planChangeTaskExecution(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  runInput: ImplementationRun,
  signal?: AbortSignal,
): Promise<ChangeTaskExecutionPlan> {
  const run = implementationRunSchema.parse(runInput);
  const instructions = await readApplyInstructions(
    command,
    workspaceDirectory,
    run.changeId,
    signal,
  );
  if (instructions.state === "blocked") {
    throw new ChangeTaskExecutionError(
      `OpenSpec apply для change «${run.changeId}» заблокирован: ${instructions.instruction}`,
    );
  }
  assertTaskProgressConsistent(instructions);
  const gitRoot = await readTaskGitRoot(command, workspaceDirectory, signal);
  await assertCleanWorktree(command, gitRoot, signal);
  const [currentBranch, baselineCommit] = await Promise.all([
    readCurrentBranch(command, gitRoot, signal),
    readHeadCommit(command, gitRoot, signal),
  ]);
  if (currentBranch !== run.implementationBranch) {
    throw new ChangeTaskExecutionError(
      `Текущей должна быть корневая ветка «${run.implementationBranch}»`,
    );
  }
  if (run.batch.kind === "empty") {
    // Baseline пустого пакета — нижняя граница будущего review: коммиты,
    // появившиеся после него вне task-сессий, войдут в диапазон пакета.
    if (!(await isCommitAncestor(command, gitRoot, run.batch.baseCommit, baselineCommit, signal))) {
      throw new ChangeTaskExecutionError(
        "Git HEAD не продолжает baseline пакета implementation-run",
      );
    }
  } else {
    const expectedHead = run.batch.kind === "collecting"
      ? run.batch.headCommit
      : run.batch.reviewCommit;
    if (baselineCommit !== expectedHead) {
      throw new ChangeTaskExecutionError(
        "Git HEAD не совпадает с сохранённым implementation-run",
      );
    }
  }
  await assertImplementationRunState(command, gitRoot, run, baselineCommit, signal);
  const numberedTasks = numberTasks(instructions.tasks);
  if (instructions.state === "all_done") {
    return {
      kind: "complete",
      schemaName: instructions.schemaName,
      reason: "change-complete",
    };
  }

  const selected = numberedTasks.find(
    ({ task, phaseNumber }) => phaseNumber === run.phaseNumber && !task.done,
  );
  if (!selected) {
    return {
      kind: "complete",
      schemaName: instructions.schemaName,
      reason: "phase-complete",
    };
  }

  const expectedTasks = instructions.tasks.map((task) =>
    task.id === selected.task.id ? { ...task, done: true } : task,
  );
  return {
    kind: "next-task",
    session: pendingTaskExecutionSessionSchema.parse({
      changeId: run.changeId,
      schemaName: instructions.schemaName,
      taskId: selected.task.id,
      taskNumber: selected.number,
      taskDescription: selected.task.description,
      phaseNumber: run.phaseNumber,
      changeBranch: run.changeBranch,
      implementationBranch: run.implementationBranch,
      rootBaselineCommit: run.rootBaselineCommit,
      baselineCommit,
      tasksBeforeDigest: taskListDigest(instructions.tasks),
      tasksAfterDigest: taskListDigest(expectedTasks),
      progressTotal: instructions.progress.total,
      progressComplete: instructions.progress.complete,
      repositoryHost: run.repository.host,
      repositoryNameWithOwner: run.repository.nameWithOwner,
      repositoryUrl: run.repository.url,
    }),
  };
}

/**
 * Сверяет сохранённую task-сессию с репозиторием. Противоречие репозитория и
 * сессии возвращается как `stale`; исключение означает, что окружение не
 * готово либо факты не удалось прочитать.
 */
export async function inspectTaskExecutionRecovery(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  gitRoot: string,
  sessionInput: PendingTaskExecutionSession,
  signal: AbortSignal,
): Promise<TaskSessionRecovery> {
  const session = pendingTaskExecutionSessionSchema.parse(sessionInput);
  await assertCleanWorktree(command, gitRoot, signal);
  const outdated = await inspectTaskSessionState(command, gitRoot, session, signal);
  if (outdated !== null) return { kind: "stale", reason: outdated };
  const instructions = await readApplyInstructions(
    command,
    workspaceDirectory,
    session.changeId,
    signal,
  );
  const mismatch = describeSessionTaskMismatch(instructions, session);
  if (mismatch !== null) return { kind: "stale", reason: mismatch };
  const digest = taskListDigest(instructions.tasks);
  if (digest === session.tasksAfterDigest) {
    const local = await inspectLocalTaskCommit(command, gitRoot, session, instructions, signal);
    return local.kind === "verified"
      ? { kind: "committed" }
      : { kind: "stale", reason: local.reason };
  }
  if (digest !== session.tasksBeforeDigest) {
    return {
      kind: "stale",
      reason: "Список OpenSpec-задач изменился после сохранения checkpoint",
    };
  }
  const head = await readHeadCommit(command, gitRoot, signal);
  if (head !== session.baselineCommit) {
    return {
      kind: "stale",
      reason: "Implementation-ветка содержит commit, но выбранная задача не отмечена выполненной",
    };
  }
  return { kind: "fresh" };
}

export async function verifyCompletedTask(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  gitRoot: string,
  sessionInput: PendingTaskExecutionSession,
  signal: AbortSignal,
): Promise<CompletedChangeTask> {
  const session = pendingTaskExecutionSessionSchema.parse(sessionInput);
  await assertCleanWorktree(command, gitRoot, signal);
  const outdated = await inspectTaskSessionState(command, gitRoot, session, signal);
  if (outdated !== null) throw new ChangeTaskExecutionError(outdated);
  const instructions = await readApplyInstructions(
    command,
    workspaceDirectory,
    session.changeId,
    signal,
  );
  const head = await verifyLocalTaskCommit(
    command,
    gitRoot,
    session,
    instructions,
    signal,
  );
  await deliverRootCommit(
    gitRoot,
    session.changeId,
    session.baselineCommit,
    head,
    signal,
    command,
  );
  const remoteHead = await readRemoteCommit(
    command,
    gitRoot,
    session.implementationBranch,
    signal,
  );
  if (remoteHead !== head) {
    throw new ChangeTaskExecutionError(
      `Git remote origin не содержит текущий HEAD корневой ветки «${session.implementationBranch}»`,
    );
  }
  return {
    changeId: session.changeId,
    taskId: session.taskId,
    taskNumber: session.taskNumber,
    branch: session.implementationBranch,
    commit: head,
    remainingTasks: instructions.progress.remaining,
  };
}

async function readApplyInstructions(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  changeId: string,
  signal?: AbortSignal,
): Promise<ApplyInstructions> {
  let stdout: string;
  try {
    ({ stdout } = await runWorkspaceMiseCommand(
      command,
      workspaceDirectory,
      "openspec",
      ["instructions", "apply", "--change", changeId, "--json"],
      signal,
    ));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeTaskExecutionError(
      `Не удалось прочитать apply-инструкции OpenSpec change «${changeId}»`,
    );
  }
  let instructions: ApplyInstructions;
  try {
    instructions = applyInstructionsSchema.parse(JSON.parse(stdout) as unknown);
  } catch {
    throw new ChangeTaskExecutionError(
      `OpenSpec вернул некорректные apply-инструкции change «${changeId}»`,
    );
  }
  if (instructions.changeName !== changeId) {
    throw new ChangeTaskExecutionError(
      `OpenSpec вернул apply-инструкции другого change вместо «${changeId}»`,
    );
  }
  const completedTasks = instructions.tasks.filter(({ done }) => done).length;
  if (
    instructions.tasks.length !== instructions.progress.total ||
    completedTasks !== instructions.progress.complete ||
    instructions.tasks.length - completedTasks !== instructions.progress.remaining ||
    (instructions.state === "all_done" && instructions.progress.remaining !== 0) ||
    (instructions.state === "ready" && instructions.progress.remaining === 0)
  ) {
    throw new ChangeTaskExecutionError(
      `OpenSpec вернул противоречивый progress change «${changeId}»`,
    );
  }
  const taskIds = instructions.tasks.map(({ id }) => id);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new ChangeTaskExecutionError(
      `OpenSpec вернул повторяющиеся внутренние ID задач change «${changeId}»`,
    );
  }
  return instructions;
}

function numberTasks(
  tasks: readonly ApplyTask[],
): readonly {
  readonly task: ApplyTask;
  readonly number: string;
  readonly phaseNumber: number;
}[] {
  const ids = new Set<string>();
  const numbered = tasks.map((task) => {
    const match = TASK_NUMBER_PREFIX.exec(task.description);
    if (!match?.[1]) {
      throw new ChangeTaskExecutionError(
        `OpenSpec-задача «${task.description}» не начинается с номера вида 1.1`,
      );
    }
    const number = taskNumberSchema.parse(match[1]);
    const phaseSegment = number.split(".")[0]!;
    const phaseNumber = Number(phaseSegment);
    if (!Number.isSafeInteger(phaseNumber) || String(phaseNumber) !== phaseSegment) {
      throw new ChangeTaskExecutionError(
        `OpenSpec-задача ${number} содержит некорректный номер фазы`,
      );
    }
    if (ids.has(task.id)) {
      throw new ChangeTaskExecutionError(`Повторяется внутренний ID задачи «${task.id}»`);
    }
    ids.add(task.id);
    return { task, number, phaseNumber };
  });
  const normalized = numbered.map(({ number }) => number.toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new ChangeTaskExecutionError(
      "Незавершённые OpenSpec-задачи содержат повторяющиеся номера",
    );
  }
  return numbered;
}

function assertTaskProgressConsistent(instructions: ApplyInstructions): void {
  const completed = instructions.tasks.filter(({ done }) => done).length;
  if (
    instructions.progress.total !== instructions.tasks.length ||
    instructions.progress.complete !== completed ||
    instructions.progress.remaining !== instructions.tasks.length - completed ||
    (instructions.state === "all_done" && instructions.progress.remaining !== 0) ||
    (instructions.state === "ready" && instructions.progress.remaining === 0)
  ) {
    throw new ChangeTaskExecutionError("OpenSpec вернул противоречивый progress задач");
  }
}

function taskListDigest(tasks: readonly ApplyTask[]): string {
  return createHash("sha256").update(JSON.stringify(tasks)).digest("hex");
}

async function verifyLocalTaskCommit(
  command: BoundedCommandRunner,
  gitRoot: string,
  session: PendingTaskExecutionSession,
  instructions: ApplyInstructions,
  signal: AbortSignal,
): Promise<string> {
  const local = await inspectLocalTaskCommit(command, gitRoot, session, instructions, signal);
  if (local.kind === "rejected") throw new ChangeTaskExecutionError(local.reason);
  return local.head;
}

/**
 * Проверяет контракт одной задачи: выбранная задача отмечена выполненной, это
 * единственное изменение task-state, а после baseline есть коммит с правками.
 */
async function inspectLocalTaskCommit(
  command: BoundedCommandRunner,
  gitRoot: string,
  session: PendingTaskExecutionSession,
  instructions: ApplyInstructions,
  signal: AbortSignal,
): Promise<LocalTaskCommit> {
  const rejected = (reason: string): LocalTaskCommit => ({ kind: "rejected", reason });
  const mismatch = describeSessionTaskMismatch(instructions, session);
  if (mismatch !== null) return rejected(mismatch);
  if (taskListDigest(instructions.tasks) !== session.tasksAfterDigest) {
    return rejected(
      `Выбранная задача ${session.taskNumber} не является единственным изменением task-state`,
    );
  }
  if (
    instructions.progress.total !== session.progressTotal ||
    instructions.progress.complete !== session.progressComplete + 1 ||
    instructions.progress.remaining !==
      session.progressTotal - session.progressComplete - 1 ||
    instructions.state === "blocked"
  ) {
    return rejected(
      `Progress OpenSpec не подтверждает завершение только задачи ${session.taskNumber}`,
    );
  }
  const currentBranch = await readCurrentBranch(command, gitRoot, signal);
  if (currentBranch !== session.implementationBranch) {
    throw new ChangeTaskExecutionError(
      `Текущей должна быть корневая ветка «${session.implementationBranch}»`,
    );
  }
  const head = await readHeadCommit(command, gitRoot, signal);
  if (!(await isCommitAncestor(command, gitRoot, session.baselineCommit, head, signal))) {
    return rejected("Текущий Git HEAD больше не продолжает baseline task-сессии");
  }
  const commitCount = await readCommitCount(command, gitRoot, session.baselineCommit, head, signal);
  if (commitCount < 1) {
    return rejected(`Для задачи ${session.taskNumber} требуется хотя бы один новый Git-коммит`);
  }
  const changedPaths = await readChangedPaths(
    command,
    gitRoot,
    session.baselineCommit,
    head,
    signal,
  );
  if (changedPaths.length === 0) {
    return rejected("Диапазон коммитов задачи не содержит изменений");
  }
  return { kind: "verified", head };
}

/** Описывает, чем OpenSpec больше не соответствует выбранной задаче сессии. */
function describeSessionTaskMismatch(
  instructions: ApplyInstructions,
  session: PendingTaskExecutionSession,
): string | null {
  if (instructions.schemaName !== session.schemaName) {
    return "Schema OpenSpec change изменилась после сохранения task checkpoint";
  }
  const selected = instructions.tasks.find(({ id }) => id === session.taskId);
  if (!selected || selected.description !== session.taskDescription) {
    return `OpenSpec больше не возвращает сохранённую задачу ${session.taskNumber}`;
  }
  return null;
}

async function assertImplementationRunState(
  command: BoundedCommandRunner,
  gitRoot: string,
  run: ImplementationRun,
  implementationHead: string,
  signal?: AbortSignal,
): Promise<void> {
  const repository = await resolveRepository(command, gitRoot, signal);
  if (
    repository.host !== run.repository.host ||
    repository.nameWithOwner.toLowerCase() !== run.repository.nameWithOwner.toLowerCase() ||
    repository.url !== run.repository.url
  ) {
    throw new ChangeTaskExecutionError(
      "Git remote origin больше не соответствует implementation-run",
    );
  }
  const [localRoot, remoteRoot] = await Promise.all([
    readLocalBranchCommit(command, gitRoot, run.changeBranch, signal),
    readRemoteCommit(command, gitRoot, run.changeBranch, signal),
  ]);
  if (localRoot !== implementationHead || remoteRoot !== implementationHead) {
    throw new ChangeTaskExecutionError(
      `Корневая ветка «${run.changeBranch}» расходится с сохранённым implementation HEAD`,
    );
  }
  await assertDescendsFrom(
    command,
    gitRoot,
    run.rootBaselineCommit,
    implementationHead,
    "Implementation-ветка больше не продолжает root baseline",
    signal,
  );
}

/**
 * Проверяет окружение task-сессии. Возвращает причину устаревания, когда Git
 * HEAD больше не продолжает baseline сессии, и `null`, когда сессия остаётся
 * на своей истории. Чужая ветка, другой репозиторий и коммиты origin, которых
 * нет локально, — ошибки окружения: новая сессия их не исправит.
 */
async function inspectTaskSessionState(
  command: BoundedCommandRunner,
  gitRoot: string,
  session: PendingTaskExecutionSession,
  signal: AbortSignal,
): Promise<string | null> {
  const currentBranch = await readCurrentBranch(command, gitRoot, signal);
  if (currentBranch !== session.implementationBranch) {
    throw new ChangeTaskExecutionError(
      `Для восстановления задачи требуется корневая ветка «${session.implementationBranch}»`,
    );
  }
  const repository = await resolveRepository(command, gitRoot, signal);
  if (
    repository.host !== session.repositoryHost ||
    repository.nameWithOwner.toLowerCase() !== session.repositoryNameWithOwner.toLowerCase() ||
    repository.url !== session.repositoryUrl
  ) {
    throw new ChangeTaskExecutionError(
      "Git remote origin больше не соответствует сохранённому репозиторию",
    );
  }
  const [localRoot, remoteRoot, head] = await Promise.all([
    readLocalBranchCommit(command, gitRoot, session.changeBranch, signal),
    readRemoteCommit(command, gitRoot, session.changeBranch, signal),
    readHeadCommit(command, gitRoot, signal),
  ]);
  if (localRoot !== head) {
    throw new ChangeTaskExecutionError(
      `Корневая ветка «${session.changeBranch}» изменилась после начала task-сессии`,
    );
  }
  if (!(await isCommitAncestor(command, gitRoot, remoteRoot, head, signal))) {
    throw new ChangeTaskExecutionError(
      `Origin корневой ветки «${session.changeBranch}» содержит коммиты, которых нет в локальной ветке`,
    );
  }
  if (!(await isCommitAncestor(command, gitRoot, session.baselineCommit, head, signal))) {
    return "Implementation-ветка больше не продолжает baseline task-сессии";
  }
  return null;
}
