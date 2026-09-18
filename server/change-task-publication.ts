import { createHash } from "node:crypto";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import {
  assertCleanTaskWorktree as assertCleanWorktree,
  assertReadyTaskPullRequest as assertReadyPullRequest,
  assertTaskCommitDescendsFrom as assertDescendsFrom,
  assertTaskPullRequestRepository as assertPullRequestRepository,
  listTaskPullRequests as listPullRequests,
  readCurrentTaskBranch as readCurrentBranch,
  readLocalTaskBranchCommit as readLocalBranchCommit,
  readOptionalRemoteTaskBranchCommit as readOptionalRemoteCommit,
  readRemoteTaskBranchCommit as readRemoteCommit,
  readSingleOpenTaskPullRequest as readSingleOpenPullRequest,
  readTaskChangedPaths as readChangedPaths,
  readTaskCommitCount as readCommitCount,
  readTaskCommitSubject as readCommitSubject,
  readTaskGitRoot,
  readTaskHeadCommit as readHeadCommit,
  resolveTaskRepository as resolveRepository,
} from "./change-task-gateway.ts";
import {
  ChangeTaskExecutionError,
  applyInstructionsSchema,
  pendingTaskExecutionSessionSchema,
  parseTaskBranch,
  parseTaskChangeId,
  taskNumberSchema,
  taskRepositoryFromSession,
  type ApplyInstructions,
  type ApplyTask,
  type ChangeTaskExecutionPlan,
  type CompletedChangeTask,
  type PendingTaskExecutionSession,
  type TaskCompletionInput,
} from "./change-task-model.ts";
import { runWorkspaceMiseCommand } from "./mise-toolchain.ts";

const TASK_NUMBER_PREFIX = /^(\d+(?:\.\d+)+(?:[A-Za-z]+)?)(?=\s|$)/u;
const CONVENTIONAL_COMMIT_SUBJECT =
  /^(?:feat|fix|refactor|test|docs|chore|build|ci|perf|style)(?:\([^\p{Cc}\p{Cf}\r\n()]{1,64}\))?!?: .+/u;
const UNSTABLE_PR_TITLE = /\b(?:wip|draft)\b|чернов/iu;

export interface TaskExecutionRecoveryState {
  readonly alreadyCommitted: boolean;
  readonly existingPullRequest: number | null;
}

export async function planChangeTaskExecution(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  changeIdInput: string,
  branchInput: string,
  signal?: AbortSignal,
): Promise<ChangeTaskExecutionPlan> {
  const changeId = parseTaskChangeId(changeIdInput);
  const parentBranch = parseTaskBranch(branchInput);
  const instructions = await readApplyInstructions(
    command,
    workspaceDirectory,
    changeId,
    signal,
  );
  if (instructions.state === "blocked") {
    throw new ChangeTaskExecutionError(
      `OpenSpec apply для change «${changeId}» заблокирован: ${instructions.instruction}`,
    );
  }
  if (instructions.state === "all_done") {
    return { kind: "complete", schemaName: instructions.schemaName };
  }

  const numberedTasks = numberPendingTasks(instructions.tasks);
  const selected = numberedTasks.find(({ task }) => !task.done);
  if (!selected) {
    throw new ChangeTaskExecutionError(
      "OpenSpec сообщает о незавершённой реализации, но не возвращает адресуемую задачу",
    );
  }
  const taskBranch = parseTaskBranch(`${changeId}-task-${selected.number}`);
  const gitRoot = await readTaskGitRoot(command, workspaceDirectory, signal);
  await assertCleanWorktree(command, gitRoot, signal);
  const [currentBranch, baselineCommit, repository] = await Promise.all([
    readCurrentBranch(command, gitRoot, signal),
    readHeadCommit(command, gitRoot, signal),
    resolveRepository(command, gitRoot, signal),
  ]);
  if (currentBranch !== parentBranch) {
    throw new ChangeTaskExecutionError(
      `Текущая Git-ветка изменилась с «${parentBranch}» на «${currentBranch}»`,
    );
  }
  const remoteParent = await readRemoteCommit(
    command,
    gitRoot,
    parentBranch,
    signal,
  );
  if (remoteParent !== baselineCommit) {
    throw new ChangeTaskExecutionError(
      `Git remote origin не содержит текущий HEAD parent-ветки «${parentBranch}»`,
    );
  }

  const parentPullRequest = await readSingleOpenPullRequest(
    command,
    gitRoot,
    repository,
    parentBranch,
    signal,
  );
  assertPullRequestRepository(parentPullRequest, repository.url);
  assertReadyPullRequest(parentPullRequest, {
    baseBranch: parentPullRequest.baseRefName,
    headBranch: parentBranch,
    headCommit: baselineCommit,
    label: "Parent pull request",
  });

  if ((await readLocalBranchCommit(command, gitRoot, taskBranch, signal)) !== null) {
    throw new ChangeTaskExecutionError(
      `Локальная task-ветка «${taskBranch}» уже существует`,
    );
  }
  if ((await readOptionalRemoteCommit(command, gitRoot, taskBranch, signal)) !== null) {
    throw new ChangeTaskExecutionError(
      `Task-ветка «${taskBranch}» уже существует в Git remote origin`,
    );
  }
  const historicalPullRequests = await listPullRequests(
    command,
    gitRoot,
    repository,
    taskBranch,
    "all",
    signal,
  );
  if (historicalPullRequests.length > 0) {
    throw new ChangeTaskExecutionError(
      `Для task-ветки «${taskBranch}» уже существует pull request`,
    );
  }

  const expectedTasks = instructions.tasks.map((task) =>
    task.id === selected.task.id ? { ...task, done: true } : task,
  );
  return {
    kind: "next-task",
    session: pendingTaskExecutionSessionSchema.parse({
      changeId,
      schemaName: instructions.schemaName,
      taskId: selected.task.id,
      taskNumber: selected.number,
      taskDescription: selected.task.description,
      parentBranch,
      parentBaseBranch: parentPullRequest.baseRefName,
      taskBranch,
      baselineCommit,
      tasksBeforeDigest: taskListDigest(instructions.tasks),
      tasksAfterDigest: taskListDigest(expectedTasks),
      progressTotal: instructions.progress.total,
      progressComplete: instructions.progress.complete,
      repositoryHost: repository.host,
      repositoryNameWithOwner: repository.nameWithOwner,
      repositoryUrl: repository.url,
      parentPullRequestNumber: parentPullRequest.number,
    }),
  };
}

export async function inspectTaskExecutionRecovery(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  gitRoot: string,
  session: PendingTaskExecutionSession,
  signal: AbortSignal,
): Promise<TaskExecutionRecoveryState> {
  await assertCleanWorktree(command, gitRoot, signal);
  await assertParentState(command, gitRoot, session, signal);
  const currentBranch = await readCurrentBranch(command, gitRoot, signal);
  if (currentBranch !== session.parentBranch && currentBranch !== session.taskBranch) {
    throw new ChangeTaskExecutionError(
      `Для восстановления задачи требуется ветка «${session.parentBranch}» или «${session.taskBranch}», активна «${currentBranch}»`,
    );
  }

  const localTaskHead = await readLocalBranchCommit(
    command,
    gitRoot,
    session.taskBranch,
    signal,
  );
  const remoteTaskHead = await readOptionalRemoteCommit(
    command,
    gitRoot,
    session.taskBranch,
    signal,
  );
  if (currentBranch === session.taskBranch && localTaskHead === null) {
    throw new ChangeTaskExecutionError(
      "Активная task-ветка отсутствует среди локальных refs",
    );
  }
  if (localTaskHead !== null) {
    await assertDescendsFrom(
      command,
      gitRoot,
      session.baselineCommit,
      localTaskHead,
      "Task-ветка больше не продолжает сохранённый baseline",
      signal,
    );
  }
  if (
    remoteTaskHead !== null &&
    remoteTaskHead !== session.baselineCommit &&
    remoteTaskHead !== localTaskHead
  ) {
    throw new ChangeTaskExecutionError(
      `Git remote origin содержит неожиданное состояние task-ветки «${session.taskBranch}»`,
    );
  }

  const instructions = await readApplyInstructions(
    command,
    workspaceDirectory,
    session.changeId,
    signal,
  );
  assertSessionSchema(instructions, session);
  const digest = taskListDigest(instructions.tasks);
  let alreadyCommitted = false;
  if (digest === session.tasksAfterDigest) {
    await verifyLocalTaskCommit(command, gitRoot, session, instructions, signal);
    alreadyCommitted = true;
  } else if (digest === session.tasksBeforeDigest) {
    if (localTaskHead !== null && localTaskHead !== session.baselineCommit) {
      throw new ChangeTaskExecutionError(
        "Task-ветка содержит commit, но выбранная OpenSpec-задача не отмечена выполненной",
      );
    }
  } else {
    throw new ChangeTaskExecutionError(
      "Список OpenSpec-задач изменился после сохранения checkpoint",
    );
  }

  const repository = taskRepositoryFromSession(session);
  const openPullRequests = await listPullRequests(
    command,
    gitRoot,
    repository,
    session.taskBranch,
    "open",
    signal,
  );
  if (openPullRequests.length > 1) {
    throw new ChangeTaskExecutionError(
      `Для task-ветки «${session.taskBranch}» найдено несколько открытых pull request`,
    );
  }
  const existing = openPullRequests[0];
  if (existing) {
    assertPullRequestRepository(existing, session.repositoryUrl);
    if (remoteTaskHead === null) {
      throw new ChangeTaskExecutionError(
        "Task pull request существует без опубликованной head-ветки",
      );
    }
    assertReadyPullRequest(existing, {
      baseBranch: session.parentBranch,
      headBranch: session.taskBranch,
      headCommit: remoteTaskHead,
      label: "Task pull request",
    });
  } else {
    const historical = await listPullRequests(
      command,
      gitRoot,
      repository,
      session.taskBranch,
      "all",
      signal,
    );
    if (historical.length > 0) {
      throw new ChangeTaskExecutionError(
        "Созданный task pull request больше не открыт; автоматическая замена запрещена",
      );
    }
  }
  return {
    alreadyCommitted,
    existingPullRequest: existing?.number ?? null,
  };
}

export async function verifyCompletedTask(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  gitRoot: string,
  session: PendingTaskExecutionSession,
  input: TaskCompletionInput,
  signal: AbortSignal,
): Promise<CompletedChangeTask> {
  if (!input.title.includes(session.taskNumber) || UNSTABLE_PR_TITLE.test(input.title)) {
    throw new ChangeTaskExecutionError(
      `Название task pull request должно содержать номер ${session.taskNumber} и не быть черновым`,
    );
  }
  await assertCleanWorktree(command, gitRoot, signal);
  await assertParentState(command, gitRoot, session, signal);
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
  const remoteHead = await readRemoteCommit(
    command,
    gitRoot,
    session.taskBranch,
    signal,
  );
  if (remoteHead !== head) {
    throw new ChangeTaskExecutionError(
      `Git remote origin не содержит текущий HEAD task-ветки «${session.taskBranch}»`,
    );
  }

  const repository = taskRepositoryFromSession(session);
  const openPullRequests = await listPullRequests(
    command,
    gitRoot,
    repository,
    session.taskBranch,
    "open",
    signal,
  );
  if (openPullRequests.length !== 1) {
    throw new ChangeTaskExecutionError(
      `Для task-ветки «${session.taskBranch}» должен существовать ровно один открытый pull request`,
    );
  }
  const pullRequest = openPullRequests[0]!;
  assertPullRequestRepository(pullRequest, session.repositoryUrl);
  assertReadyPullRequest(pullRequest, {
    baseBranch: session.parentBranch,
    headBranch: session.taskBranch,
    headCommit: head,
    label: "Task pull request",
  });
  if (pullRequest.number !== input.pullRequestNumber) {
    throw new ChangeTaskExecutionError(
      `Ожидался task pull request #${pullRequest.number}, передан #${input.pullRequestNumber}`,
    );
  }
  if (pullRequest.title !== input.title || pullRequest.body !== input.body) {
    throw new ChangeTaskExecutionError(
      "Название или описание task pull request не совпадает с подтверждаемым содержимым",
    );
  }

  return {
    changeId: session.changeId,
    taskNumber: session.taskNumber,
    branch: session.taskBranch,
    remainingTasks: instructions.progress.remaining,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
      title: pullRequest.title,
    },
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

function numberPendingTasks(
  tasks: readonly ApplyTask[],
): readonly { readonly task: ApplyTask; readonly number: string }[] {
  const numbered = tasks.filter(({ done }) => !done).map((task) => {
    const match = TASK_NUMBER_PREFIX.exec(task.description);
    if (!match?.[1]) {
      throw new ChangeTaskExecutionError(
        `Незавершённая OpenSpec-задача «${task.description}» не начинается с номера вида 1.1`,
      );
    }
    const number = taskNumberSchema.parse(match[1]);
    return { task, number };
  });
  const normalized = numbered.map(({ number }) => number.toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new ChangeTaskExecutionError(
      "Незавершённые OpenSpec-задачи содержат повторяющиеся номера",
    );
  }
  return numbered;
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
  if (currentBranch !== session.taskBranch) {
    throw new ChangeTaskExecutionError(
      `Текущая Git-ветка должна быть task-веткой «${session.taskBranch}»`,
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
  const commitCount = await readCommitCount(
    command,
    gitRoot,
    session.baselineCommit,
    head,
    signal,
  );
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

async function assertParentState(
  command: BoundedCommandRunner,
  gitRoot: string,
  session: PendingTaskExecutionSession,
  signal: AbortSignal,
): Promise<void> {
  const repository = await resolveRepository(command, gitRoot, signal);
  if (
    repository.host !== session.repositoryHost ||
    repository.nameWithOwner.toLowerCase() !==
      session.repositoryNameWithOwner.toLowerCase() ||
    repository.url !== session.repositoryUrl
  ) {
    throw new ChangeTaskExecutionError(
      "Git remote origin больше не соответствует сохранённому GitHub-репозиторию",
    );
  }
  const [localParent, remoteParent] = await Promise.all([
    readLocalBranchCommit(command, gitRoot, session.parentBranch, signal),
    readRemoteCommit(command, gitRoot, session.parentBranch, signal),
  ]);
  if (
    localParent !== session.baselineCommit ||
    remoteParent !== session.baselineCommit
  ) {
    throw new ChangeTaskExecutionError(
      `Parent-ветка «${session.parentBranch}» изменилась после начала task-этапа`,
    );
  }
  const parentPullRequest = await readSingleOpenPullRequest(
    command,
    gitRoot,
    repository,
    session.parentBranch,
    signal,
  );
  if (parentPullRequest.number !== session.parentPullRequestNumber) {
    throw new ChangeTaskExecutionError(
      "Открытый pull request parent-ветки изменился после начала task-этапа",
    );
  }
  assertPullRequestRepository(parentPullRequest, session.repositoryUrl);
  assertReadyPullRequest(parentPullRequest, {
    baseBranch: session.parentBaseBranch,
    headBranch: session.parentBranch,
    headCommit: session.baselineCommit,
    label: "Parent pull request",
  });
}
