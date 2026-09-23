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
  readTaskCommitSubject as readCommitSubject,
  readTaskGitRoot,
  readTaskHeadCommit as readHeadCommit,
  resolveTaskRepository as resolveRepository,
} from "./change-task-gateway.ts";
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
const CONVENTIONAL_COMMIT_SUBJECT =
  /^(?:feat|fix|refactor|test|docs|chore|build|ci|perf|style)(?:\([^\p{Cc}\p{Cf}\r\n()]{1,64}\))?!?: .+/u;

export interface TaskExecutionRecoveryState {
  readonly alreadyCommitted: boolean;
}

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
  const expectedHead = run.batch.kind === "empty"
    ? run.batch.baseCommit
    : run.batch.kind === "collecting"
      ? run.batch.headCommit
      : run.batch.reviewCommit;
  if (baselineCommit !== expectedHead) {
    throw new ChangeTaskExecutionError(
      "Git HEAD не совпадает с сохранённым implementation-run",
    );
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

export async function inspectTaskExecutionRecovery(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  gitRoot: string,
  sessionInput: PendingTaskExecutionSession,
  signal: AbortSignal,
): Promise<TaskExecutionRecoveryState> {
  const session = pendingTaskExecutionSessionSchema.parse(sessionInput);
  await assertCleanWorktree(command, gitRoot, signal);
  await assertTaskSessionState(command, gitRoot, session, signal);
  const instructions = await readApplyInstructions(
    command,
    workspaceDirectory,
    session.changeId,
    signal,
  );
  assertSessionSchema(instructions, session);
  const digest = taskListDigest(instructions.tasks);
  if (digest === session.tasksAfterDigest) {
    await verifyLocalTaskCommit(command, gitRoot, session, instructions, signal);
    return { alreadyCommitted: true };
  }
  if (digest !== session.tasksBeforeDigest) {
    throw new ChangeTaskExecutionError(
      "Список OpenSpec-задач изменился после сохранения checkpoint",
    );
  }
  const head = await readHeadCommit(command, gitRoot, signal);
  if (head !== session.baselineCommit) {
    throw new ChangeTaskExecutionError(
      "Implementation-ветка содержит commit, но выбранная задача не отмечена выполненной",
    );
  }
  return { alreadyCommitted: false };
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
  await assertTaskSessionState(command, gitRoot, session, signal);
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
  assertSessionSchema(instructions, session);
  if (taskListDigest(instructions.tasks) !== session.tasksAfterDigest) {
    throw new ChangeTaskExecutionError(
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
    throw new ChangeTaskExecutionError(
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
  await assertDescendsFrom(
    command,
    gitRoot,
    session.baselineCommit,
    head,
    "Текущий Git HEAD больше не продолжает baseline task-сессии",
    signal,
  );
  const commitCount = await readCommitCount(command, gitRoot, session.baselineCommit, head, signal);
  if (commitCount !== 1) {
    throw new ChangeTaskExecutionError(
      `Для задачи ${session.taskNumber} требуется ровно один отдельный Git-коммит`,
    );
  }
  const changedPaths = await readChangedPaths(
    command,
    gitRoot,
    session.baselineCommit,
    head,
    signal,
  );
  if (changedPaths.length === 0) {
    throw new ChangeTaskExecutionError("Task-коммит не содержит изменений");
  }
  const subject = await readCommitSubject(command, gitRoot, head, signal);
  if (subject.length > 71 || !CONVENTIONAL_COMMIT_SUBJECT.test(subject)) {
    throw new ChangeTaskExecutionError(
      "Task-коммит должен иметь Conventional Commit subject короче 72 символов",
    );
  }
  return head;
}

function assertSessionSchema(
  instructions: ApplyInstructions,
  session: PendingTaskExecutionSession,
): void {
  if (instructions.schemaName !== session.schemaName) {
    throw new ChangeTaskExecutionError(
      "Schema OpenSpec change изменилась после сохранения task checkpoint",
    );
  }
  const selected = instructions.tasks.find(({ id }) => id === session.taskId);
  if (!selected || selected.description !== session.taskDescription) {
    throw new ChangeTaskExecutionError(
      `OpenSpec больше не возвращает сохранённую задачу ${session.taskNumber}`,
    );
  }
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

async function assertTaskSessionState(
  command: BoundedCommandRunner,
  gitRoot: string,
  session: PendingTaskExecutionSession,
  signal: AbortSignal,
): Promise<void> {
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
  if (localRoot !== head ||
      (remoteRoot !== session.baselineCommit && remoteRoot !== head)) {
    throw new ChangeTaskExecutionError(
      `Корневая ветка «${session.changeBranch}» изменилась после начала task-сессии`,
    );
  }
  await assertDescendsFrom(
    command,
    gitRoot,
    session.baselineCommit,
    head,
    "Implementation-ветка больше не продолжает baseline task-сессии",
    signal,
  );
}
