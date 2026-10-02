import assert from "node:assert/strict";
import test from "node:test";
import { classifyPhaseWork, PhaseWorkError, phaseTaskFingerprint } from "../server/phase-work.ts";
import { RootBranchDeliveryError } from "../server/root-branch-delivery.ts";
import { createWorkflowReconciler } from "../server/workflow/reconciliation.ts";
import { createInitialWorkflowState, workflowStateSchema } from "../server/workflow/types.ts";

const changeId = "reconciled-change";
const changeBranch = `change/${changeId}`;
const repository = {
  host: "github.com",
  nameWithOwner: "example/project",
  url: "https://github.com/example/project",
};
const commits = Object.fromEntries(
  ["root", "base", "first", "second", "review", "extra", "head", "other"].map((name, index) => [
    name,
    String(index + 1).repeat(40),
  ]),
);

/** Задача снимка OpenSpec: ID — позиция в файле. */
function task(position, number, title, done = false) {
  const id = String(position);
  const description = `${number} ${title}`;
  return {
    id, number, description, done,
    phaseNumber: Number(number.split(".")[0]),
    fingerprint: phaseTaskFingerprint(id, number, description),
  };
}

function snapshot(tasks, phases = [1, 2]) {
  return {
    phases: phases.map((number) => ({ number })),
    tasks,
    schemaName: "spec-driven",
    planPath: `/repo/openspec/changes/${changeId}/plan.md`,
    taskArtifactPaths: [`/repo/openspec/changes/${changeId}/tasks.md`],
  };
}

function progress(tasks, phases = [1, 2], nextImplementationRun = 3) {
  return {
    phases: phases.map((number) => ({ number })),
    tasks: tasks.map(({ id, number, description, done, fingerprint }) => ({
      id, number, description, done, fingerprint,
    })),
    nextImplementationRun,
  };
}

function implementationRun(batch, publication = { kind: "unreviewed" }) {
  return {
    changeId,
    changeBranch,
    implementationBranch: changeBranch,
    phaseNumber: 2,
    runNumber: 2,
    rootBaselineCommit: commits.root,
    repository,
    publication,
    batch,
  };
}

function taskSession(overrides = {}) {
  return {
    changeId,
    schemaName: "spec-driven",
    taskId: "3",
    taskNumber: "2.2",
    taskDescription: "2.2 Оболочка",
    phaseNumber: 2,
    changeBranch,
    implementationBranch: changeBranch,
    rootBaselineCommit: commits.root,
    baselineCommit: commits.first,
    tasksBeforeDigest: "a".repeat(64),
    tasksAfterDigest: "b".repeat(64),
    progressTotal: 4,
    progressComplete: 2,
    repositoryHost: repository.host,
    repositoryNameWithOwner: repository.nameWithOwner,
    repositoryUrl: repository.url,
    ...overrides,
  };
}

function baseState(overrides = {}) {
  return workflowStateSchema.parse({
    ...createInitialWorkflowState(),
    changeBranch,
    activeBranch: changeBranch,
    change: { id: changeId },
    ...overrides,
  });
}

// Начало пакета: Phase 1 завершена, в Phase 2 три невыполненные задачи.
const baselineTasks = [
  task(1, "1.1", "Схема", true),
  task(2, "2.1", "Чтение"),
  task(3, "2.2", "Оболочка"),
  task(4, "2.3", "Замена вставок"),
];
const afterFirstTask = [
  task(1, "1.1", "Схема", true),
  task(2, "2.1", "Чтение", true),
  task(3, "2.2", "Оболочка"),
  task(4, "2.3", "Замена вставок"),
];
const collectingBatch = {
  kind: "collecting",
  baseCommit: commits.base,
  headCommit: commits.first,
  tasks: [{ taskId: "2", taskNumber: "2.1", commit: commits.first }],
};

/**
 * Рабочая область с управляемыми фактами: положение корневой ветки, история
 * коммитов, список задач и ответы оценки pending-сессий.
 */
function workspace({
  position,
  head = commits.first,
  origin = { kind: "synchronized" },
  tasks = afterFirstTask,
  phases = [1, 2],
  ancestors = Object.values(commits),
  mergeBases = {},
  assessments = {},
  inspectTasks,
  publish,
} = {}) {
  const calls = [];
  const known = new Set(ancestors);
  const assessor = (name) => async (...args) => {
    calls.push(`assess:${name}`);
    const answer = assessments[name];
    if (answer === undefined) throw new Error(`Оценка сессии «${name}» не ожидалась`);
    return typeof answer === "function" ? answer(...args) : answer;
  };
  const reconcile = createWorkflowReconciler({
    workspaceDirectory: "/repo",
    rootBranch: {
      async inspect(_directory, branch) {
        calls.push("inspect");
        assert.equal(branch, changeBranch);
        return position ?? { kind: "available", head, origin };
      },
      async publish(_directory, publishedChange, remoteHead, publishedHead) {
        calls.push(`publish:${remoteHead.slice(0, 1)}..${publishedHead.slice(0, 1)}`);
        assert.equal(publishedChange, changeId);
        if (publish) await publish();
      },
      async nearestAncestors(_directory, requested) {
        return new Map(requested.map((commit) => [
          commit,
          known.has(commit) ? commit : mergeBases[commit] ?? null,
        ]));
      },
    },
    phaseWork: {
      async inspect(_directory, inspectedChange, previous) {
        calls.push("tasks");
        assert.equal(inspectedChange, changeId);
        assert.equal(previous, null);
        if (inspectTasks) return inspectTasks();
        return classifyPhaseWork(snapshot(tasks, phases), null);
      },
    },
    sessions: {
      changeInitialization: assessor("changeInitialization"),
      artifact: assessor("artifact"),
      review: assessor("review"),
      findingResolution: assessor("findingResolution"),
      implementationFindingResolution: assessor("implementationFindingResolution"),
      taskExecution: assessor("taskExecution"),
      implementationReview: assessor("implementationReview"),
      phaseTaskPlanning: assessor("phaseTaskPlanning"),
      archive: assessor("archive"),
    },
  });
  return {
    calls,
    run: (stepId, state) => reconcile({ signal: new AbortController().signal, stepId, state }),
  };
}

test("шаги исходных условий и состояние без change не сверяются", async () => {
  const value = workspace();
  for (const stepId of ["check-agent-profiles", "check-git-branch", "check-git-worktree", "check-mise-toolchain"]) {
    assert.deepEqual(await value.run(stepId, baseState()), { kind: "unchanged" });
  }
  assert.deepEqual(
    await value.run("initialize-change", createInitialWorkflowState()),
    { kind: "unchanged" },
  );
  assert.deepEqual(value.calls, []);
});

test("сессия инициализации оценивается до появления change в состоянии", async () => {
  const session = {
    changeId,
    changeBranch,
    baselineCommit: commits.base,
    changeExisted: false,
    openSpecRoot: "/repo/openspec",
    existingRootPullRequest: null,
  };
  // Change записывается в состояние только после инициализации.
  const state = baseState({ change: null, pendingChangeInitializationSession: session });

  const resumable = workspace({
    origin: { kind: "absent" },
    assessments: { changeInitialization: { kind: "resumable" } },
  });
  assert.deepEqual(await resumable.run("initialize-change", state), { kind: "unchanged" });
  assert.deepEqual(resumable.calls, ["inspect", "assess:changeInitialization"]);

  // Коммит вне scaffold: инициализация готовится заново от текущего HEAD, а
  // публикацию выполняет сам шаг.
  const stale = workspace({
    origin: { kind: "unpublished", remoteHead: commits.base, commits: 2 },
    assessments: {
      changeInitialization: {
        kind: "stale",
        reason: "После baseline сессии инициализации появились коммиты вне каталога change",
      },
    },
  });
  const result = await stale.run("initialize-change", state);
  assert.equal(result.kind, "adopted");
  assert.equal(result.next, "initialize-change");
  assert.equal(result.state.pendingChangeInitializationSession, null);
  assert.equal(
    result.summary,
    "Принято состояние репозитория: сессия инициализации change сброшена (После baseline сессии инициализации появились коммиты вне каталога change)",
  );
  assert.deepEqual(stale.calls, ["inspect", "assess:changeInitialization"]);
  workflowStateSchema.parse(result.state);
});

test("чужая ветка и незакоммиченные правки оставляют сообщение шагу", async () => {
  for (const reason of ["other-branch", "dirty-worktree"]) {
    const value = workspace({ position: { kind: "unavailable", reason } });
    const state = baseState({
      phaseProgress: progress(baselineTasks),
      implementationRun: implementationRun(collectingBatch),
      pendingTaskExecutionSession: taskSession(),
    });
    assert.deepEqual(await value.run("execute-change-tasks", state), { kind: "unchanged" });
    assert.deepEqual(value.calls, ["inspect"]);
  }
});

test("расхождение с origin останавливает workflow с командой для пользователя", async () => {
  const expectations = {
    behind: /git pull --ff-only origin change\/reconciled-change/u,
    unfetched: /git pull --rebase origin change\/reconciled-change.*git push --force-with-lease/u,
    diverged: /оркестратор не перезаписывает origin.*git push --force-with-lease origin change\/reconciled-change/u,
  };
  for (const [kind, expected] of Object.entries(expectations)) {
    const value = workspace({ origin: { kind, remoteHead: commits.other } });
    const result = await value.run("execute-change-tasks", baseState());
    assert.equal(result.kind, "halt");
    assert.match(result.message, expected);
    assert.match(result.message, /«Повторить»/u);
    assert.ok(result.message.startsWith(result.summary));
    assert.deepEqual(value.calls, ["inspect"]);
  }
});

test("состояние, соответствующее репозиторию, не меняется", async () => {
  const value = workspace();
  const state = baseState({
    phaseProgress: progress(baselineTasks),
    implementationRun: implementationRun(collectingBatch),
  });
  assert.deepEqual(await value.run("execute-change-tasks", state), { kind: "unchanged" });
  assert.deepEqual(value.calls, ["inspect", "tasks"]);
});

test("локальные коммиты публикуются только перед шагами, которым нужен опубликованный HEAD", async () => {
  const origin = { kind: "unpublished", remoteHead: commits.base, commits: 2 };
  const artifacts = workspace({ origin });
  assert.deepEqual(await artifacts.run("create-change-artifacts", baseState()), { kind: "unchanged" });
  assert.deepEqual(artifacts.calls, ["inspect"]);

  const review = workspace({ origin });
  const result = await review.run("review-change", baseState());
  assert.equal(result.kind, "adopted");
  assert.equal(result.next, "review-change");
  assert.equal(result.summary, "Принято состояние репозитория: опубликовано коммитов: 2");
  assert.deepEqual(review.calls, ["inspect", "publish:2..3"]);
});

test("отказ публикации останавливает workflow с причиной", async () => {
  const value = workspace({
    origin: { kind: "unpublished", remoteHead: commits.base, commits: 1 },
    publish: async () => {
      throw new RootBranchDeliveryError("Корневой PR изменился или уже закрыт");
    },
  });
  const result = await value.run("inspect-phase-work", baseState());
  assert.equal(result.kind, "halt");
  assert.match(result.summary, /Не удалось опубликовать локальные коммиты: Корневой PR изменился или уже закрыт/u);
  assert.match(result.message, /исправьте состояние корневого PR или origin и нажмите «Повторить»/u);
});

test("перестановка задач во время task-сессии принимается без потери пакета review", async () => {
  // Пользователь попросил агента задачи 2.2 переставить задачи: агент сделал
  // два коммита и не завершил этап.
  const reordered = [
    task(1, "1.1", "Схема", true),
    task(2, "2.1", "Чтение", true),
    task(3, "2.2", "Замена вставок"),
    task(4, "2.3", "Оболочка"),
  ];
  const value = workspace({
    head: commits.head,
    origin: { kind: "unpublished", remoteHead: commits.first, commits: 2 },
    tasks: reordered,
    assessments: {
      taskExecution: { kind: "stale", reason: "OpenSpec больше не возвращает сохранённую задачу 2.2" },
    },
  });
  const state = baseState({
    phaseProgress: progress(baselineTasks),
    implementationRun: implementationRun(collectingBatch),
    pendingTaskExecutionSession: taskSession(),
  });
  const result = await value.run("execute-change-tasks", state);

  assert.equal(result.kind, "adopted");
  assert.equal(result.next, "execute-change-tasks");
  assert.equal(result.state.pendingTaskExecutionSession, null);
  assert.deepEqual(result.state.implementationRun.batch, {
    ...collectingBatch,
    headCommit: commits.head,
  });
  assert.deepEqual(
    result.state.phaseProgress.tasks.map(({ id, description, done }) => [id, description, done]),
    [
      ["1", "1.1 Схема", true],
      ["2", "2.1 Чтение", false],
      ["3", "2.2 Замена вставок", false],
      ["4", "2.3 Оболочка", false],
    ],
  );
  assert.equal(
    result.summary,
    "Принято состояние репозитория: " +
      "принят изменённый список задач (Список задач перестал сохранять точный префикс на позиции 3); " +
      "сессия задачи 2.2 сброшена (OpenSpec больше не возвращает сохранённую задачу 2.2); " +
      "пакет implementation продолжен до текущего HEAD; " +
      "опубликовано коммитов: 2",
  );
  assert.deepEqual(value.calls, ["inspect", "tasks", "assess:taskExecution", "publish:3..7"]);
  // Принятое состояние проходит схему checkpoint.
  workflowStateSchema.parse(result.state);
});

test("продолжаемая сессия удерживает run и неопубликованные коммиты своего этапа", async () => {
  const value = workspace({
    head: commits.second,
    origin: { kind: "unpublished", remoteHead: commits.first, commits: 1 },
    tasks: [
      task(1, "1.1", "Схема", true),
      task(2, "2.1", "Чтение", true),
      task(3, "2.2", "Оболочка", true),
      task(4, "2.3", "Замена вставок"),
    ],
    assessments: { taskExecution: { kind: "resumable" } },
  });
  const state = baseState({
    phaseProgress: progress(baselineTasks),
    implementationRun: implementationRun(collectingBatch),
    pendingTaskExecutionSession: taskSession(),
  });
  assert.deepEqual(await value.run("execute-change-tasks", state), { kind: "unchanged" });
  assert.deepEqual(value.calls, ["inspect", "tasks", "assess:taskExecution"]);
});

test("сессия, которую не удалось оценить, оставляет состояние нетронутым", async (context) => {
  context.mock.method(console, "warn", () => undefined);
  // Список задач изменён, но без оценки сессии принимать его нельзя: сессия
  // может владеть и baseline задач, и пакетом.
  const value = workspace({
    head: commits.head,
    origin: { kind: "unpublished", remoteHead: commits.first, commits: 2 },
    tasks: [
      task(1, "1.1", "Схема", true),
      task(2, "2.1", "Чтение", true),
      task(3, "2.2", "Замена вставок"),
      task(4, "2.3", "Оболочка"),
    ],
    assessments: {
      taskExecution: () => {
        throw new Error("GitHub CLI недоступен");
      },
    },
  });
  const state = baseState({
    phaseProgress: progress(baselineTasks),
    implementationRun: implementationRun(collectingBatch),
    pendingTaskExecutionSession: taskSession(),
  });
  assert.deepEqual(await value.run("execute-change-tasks", state), { kind: "unchanged" });
  assert.deepEqual(value.calls, ["inspect", "tasks", "assess:taskExecution"]);
});

test("коммит после завершения задачи продолжает пакет и публикуется", async () => {
  const value = workspace({
    head: commits.extra,
    origin: { kind: "unpublished", remoteHead: commits.first, commits: 1 },
  });
  const state = baseState({
    phaseProgress: progress(baselineTasks),
    implementationRun: implementationRun(collectingBatch),
  });
  const result = await value.run("execute-change-tasks", state);
  assert.equal(result.kind, "adopted");
  assert.equal(result.state.implementationRun.batch.headCommit, commits.extra);
  assert.equal(
    result.summary,
    "Принято состояние репозитория: пакет implementation продолжен до текущего HEAD; опубликовано коммитов: 1",
  );
});

test("implementation review откладывается, пока в фазе есть незавершённые задачи", async () => {
  // После начала review-шага пользователь снова открыл задачу пакета.
  const value = workspace({
    tasks: baselineTasks,
    assessments: {
      implementationReview: {
        kind: "stale",
        reason: "Выполненная задача 2.1 удалена, перенумерована или снова открыта во время review",
      },
    },
  });
  const state = baseState({
    phaseProgress: progress(baselineTasks),
    implementationRun: implementationRun(collectingBatch),
    pendingImplementationReviewSession: {
      changeId,
      changeBranch,
      implementationBranch: changeBranch,
      rootBaselineCommit: commits.root,
      baseCommit: commits.base,
      reviewedHead: commits.first,
      tasks: collectingBatch.tasks,
      repository,
    },
  });
  const result = await value.run("review-implementation", state);
  assert.equal(result.kind, "adopted");
  assert.equal(result.next, "execute-change-tasks");
  assert.equal(result.state.pendingImplementationReviewSession, null);
  assert.deepEqual(result.state.implementationRun.batch, { kind: "empty", baseCommit: commits.base });
  assert.match(result.summary, /из пакета исключены задачи, которых нет среди завершённых задач фазы: 2\.1/u);
  assert.match(result.summary, /implementation review отложен: в Phase 2 есть незавершённые задачи/u);
  workflowStateSchema.parse(result.state);
});

test("завершённый review переводит workflow к findings пакета", async () => {
  const completed = [
    task(1, "1.1", "Схема", true),
    task(2, "2.1", "Чтение", true),
    task(3, "2.2", "Оболочка", true),
    task(4, "2.3", "Замена вставок", true),
  ];
  const reviewed = implementationRun(
    { ...collectingBatch, kind: "reviewed", reviewCommit: commits.review },
    { kind: "reviewed", number: 41, url: "https://github.com/example/project/pull/41", title: "Change" },
  );
  const state = baseState({
    phaseProgress: progress(baselineTasks),
    implementationRun: reviewed,
  });

  // Review сохранил результат, но шаг прервался до перехода к findings.
  const interrupted = await workspace({ head: commits.review, tasks: completed })
    .run("review-implementation", state);
  assert.equal(interrupted.kind, "adopted");
  assert.equal(interrupted.next, "resolve-review-findings");
  assert.deepEqual(interrupted.state.implementationRun, reviewed);
  assert.equal(
    interrupted.summary,
    "Принято состояние репозитория: implementation review пакета уже завершён: workflow переходит к его findings",
  );

  // Во время устранения findings пакет остаётся записью о выполненном review,
  // даже когда пользователь добавил коммиты или переписал коммиты пакета.
  for (const stepId of ["resolve-review-findings", "resolve-implementation-review-findings"]) {
    assert.deepEqual(
      await workspace({ head: commits.head, tasks: completed }).run(stepId, state),
      { kind: "unchanged" },
    );
    const rewritten = await workspace({
      head: commits.other,
      tasks: completed,
      ancestors: [commits.root, commits.other],
    }).run(stepId, state);
    assert.deepEqual(rewritten, { kind: "unchanged" });
  }
});

test("задача, завершённая вне task-сессии, попадает в пакет перед review", async () => {
  const completedByHand = [
    task(1, "1.1", "Схема", true),
    task(2, "2.1", "Чтение", true),
    task(3, "2.2", "Оболочка", true),
    task(4, "2.3", "Замена вставок", true),
  ];
  const value = workspace({ head: commits.head, tasks: completedByHand });
  const state = baseState({
    phaseProgress: progress(baselineTasks),
    implementationRun: implementationRun(collectingBatch),
  });
  const result = await value.run("review-implementation", state);
  assert.equal(result.kind, "adopted");
  assert.equal(result.next, "review-implementation");
  assert.deepEqual(result.state.implementationRun.batch.tasks, [
    { taskId: "2", taskNumber: "2.1", commit: commits.first },
    { taskId: "3", taskNumber: "2.2", commit: null },
    { taskId: "4", taskNumber: "2.3", commit: null },
  ]);
  assert.equal(result.state.implementationRun.batch.headCommit, commits.head);
});

test("архивация откладывается, когда в change появилась незавершённая работа", async () => {
  const completed = [task(1, "1.1", "Схема", true), task(2, "2.1", "Чтение", true)];
  const value = workspace({ tasks: [...completed, task(3, "2.2", "Новая задача")] });
  const state = baseState({ phaseProgress: progress(completed) });
  const result = await value.run("archive-change", state);
  assert.equal(result.kind, "adopted");
  assert.equal(result.next, "inspect-phase-work");
  assert.equal(
    result.summary,
    "Принято состояние репозитория: архивация отложена: в change появилась незавершённая работа",
  );
  // Завершённый change архивируется без вмешательства согласования.
  assert.deepEqual(
    await workspace({ tasks: completed }).run("archive-change", state),
    { kind: "unchanged" },
  );
});

test("сессия архивации оценивается до чтения задач", async () => {
  const completed = [task(1, "1.1", "Схема", true), task(2, "2.1", "Чтение", true)];
  const archiveSession = {
    changeId,
    branch: changeBranch,
    baselineCommit: commits.first,
    sourcePath: `openspec/changes/${changeId}`,
    archivePath: `openspec/changes/archive/2026-10-02-${changeId}`,
    deltaSpecPaths: [],
    rootPullRequest: {
      number: 41,
      url: `${repository.url}/pull/41`,
      repositoryHost: repository.host,
      repositoryNameWithOwner: repository.nameWithOwner,
      repositoryUrl: repository.url,
      changeBranch,
    },
  };
  const state = baseState({
    phaseProgress: progress(completed),
    rootPullRequest: archiveSession.rootPullRequest,
    pendingArchiveSession: archiveSession,
  });
  // Архивный коммит уже перенёс change: активных задач больше нет.
  const committed = workspace({
    head: commits.head,
    origin: { kind: "unpublished", remoteHead: commits.first, commits: 1 },
    assessments: { archive: { kind: "resumable" } },
    inspectTasks: () => {
      throw new Error("Задачи архивированного change не читаются");
    },
  });
  assert.deepEqual(await committed.run("archive-change", state), { kind: "unchanged" });
  assert.deepEqual(committed.calls, ["inspect", "assess:archive"]);

  const stale = workspace({
    head: commits.head,
    tasks: completed,
    assessments: {
      archive: { kind: "stale", reason: "После baseline архивации появились коммиты, которые не архивируют change" },
    },
  });
  const result = await stale.run("archive-change", state);
  assert.equal(result.kind, "adopted");
  assert.equal(result.next, "archive-change");
  assert.equal(result.state.pendingArchiveSession, null);
  assert.deepEqual(stale.calls, ["inspect", "assess:archive", "tasks"]);
});

test("целевая фаза сверяется с задачами перед подготовкой run", async () => {
  const completed = [task(1, "1.1", "Схема", true)];
  const state = baseState({
    phaseProgress: progress(completed),
    phaseTarget: { kind: "planning", phaseNumber: 2 },
  });
  // Фаза 2 по-прежнему без задач: планирование остаётся следующей работой.
  assert.deepEqual(
    await workspace({ tasks: completed }).run("prepare-phase-planning-branch", state),
    { kind: "unchanged" },
  );
  // Пользователь сам добавил задачи Phase 2.
  const planned = workspace({ tasks: [...completed, task(2, "2.1", "Чтение")] });
  const result = await planned.run("prepare-phase-planning-branch", state);
  assert.equal(result.kind, "adopted");
  assert.equal(result.next, "inspect-phase-work");
  assert.equal(result.state.phaseTarget, null);
  assert.equal(
    result.summary,
    "Принято состояние репозитория: Phase 2 больше не является следующей работой",
  );
});

test("устаревшая проверка корневой ветки сбрасывается при сдвиге HEAD", async () => {
  const completed = [task(1, "1.1", "Схема", true), task(2, "2.1", "Чтение")];
  const session = {
    changeId,
    changeBranch,
    implementationBranch: changeBranch,
    phaseNumber: 2,
    runNumber: 2,
    rootBaselineCommit: commits.first,
    repository,
  };
  const state = baseState({
    phaseProgress: progress(completed),
    phaseTarget: { kind: "implementation", phaseNumber: 2, runNumber: 2 },
    pendingImplementationBranchSession: session,
  });
  assert.deepEqual(
    await workspace({ tasks: completed }).run("prepare-implementation-branch", state),
    { kind: "unchanged" },
  );
  const moved = await workspace({ tasks: completed, head: commits.head })
    .run("prepare-implementation-branch", state);
  assert.equal(moved.kind, "adopted");
  assert.equal(moved.state.pendingImplementationBranchSession, null);
  assert.equal(
    moved.summary,
    "Принято состояние репозитория: проверка корневой ветки перед реализацией сброшена (Git HEAD изменился после проверки корневой ветки)",
  );
});

test("planning run переносит baseline, планирует заново или прекращается", async () => {
  const done = [task(1, "1.1", "Схема", true)];
  const planningRun = {
    changeId,
    changeBranch,
    planningBranch: changeBranch,
    phaseNumber: 2,
    rootBaselineCommit: commits.first,
    baselineProgress: progress(done, [1, 2], 2),
  };
  const state = baseState({ phaseProgress: progress(done, [1, 2], 2), planningRun });
  const planned = [task(2, "2.1", "Чтение"), task(3, "2.2", "Экран")];

  // Перестановка задач планируемой фазы не затрагивает baseline.
  assert.deepEqual(
    await workspace({ tasks: [done[0], planned[1], planned[0]] }).run("review-change", state),
    { kind: "unchanged" },
  );

  // Правка завершённой задачи предыдущей фазы переносит baseline.
  const reworded = await workspace({
    tasks: [task(1, "1.1", "Схема хранения", true), ...planned],
  }).run("review-change", state);
  assert.equal(reworded.kind, "adopted");
  assert.equal(reworded.next, "review-change");
  assert.deepEqual(
    reworded.state.planningRun.baselineProgress.tasks.map(({ description }) => description),
    ["1.1 Схема хранения"],
  );
  workflowStateSchema.parse(reworded.state);

  // Задачи фазы удалены после планирования: фаза планируется заново.
  const removed = await workspace({ tasks: done }).run("validate-phase-planning", state);
  assert.equal(removed.kind, "adopted");
  assert.equal(removed.next, "plan-phase-tasks");
  assert.match(removed.summary, /задачи Phase 2 удалены: фаза планируется заново/u);

  // Снова открытая задача предыдущей фазы требует реализации до планирования.
  const reopened = await workspace({
    tasks: [task(1, "1.1", "Схема"), ...planned],
  }).run("review-change", state);
  assert.equal(reopened.kind, "adopted");
  assert.equal(reopened.next, "inspect-phase-work");
  assert.equal(reopened.state.planningRun, null);
  assert.match(reopened.summary, /планирование Phase 2 прекращено \(Завершённая задача 1\.1 снова открыта\)/u);
  workflowStateSchema.parse(reopened.state);

  // Задачи фазы завершены вручную: планировать и проверять план уже нечего.
  const completedByHand = await workspace({
    tasks: [done[0], task(2, "2.1", "Чтение", true)],
  }).run("resolve-review-findings", state);
  assert.equal(completedByHand.next, "inspect-phase-work");
  assert.match(completedByHand.summary, /планирование Phase 2 прекращено/u);

  // Часть задач фазы уже выполнена: фаза перешла к реализации, и планирование
  // прекращается на любом своём шаге.
  for (const stepId of ["plan-phase-tasks", "review-change", "validate-phase-planning"]) {
    const started = await workspace({
      tasks: [done[0], task(2, "2.1", "Чтение", true), task(3, "2.2", "Экран")],
    }).run(stepId, state);
    assert.equal(started.kind, "adopted");
    assert.equal(started.next, "inspect-phase-work");
    assert.equal(started.state.planningRun, null);
    assert.equal(
      started.summary,
      "Принято состояние репозитория: планирование Phase 2 прекращено (Новая задача 2.1 уже отмечена завершённой)",
    );
    workflowStateSchema.parse(started.state);
  }
});

test("implementation run прекращается, когда в его фазе не осталось задач", async () => {
  const value = workspace({ tasks: [task(1, "1.1", "Схема", true)] });
  const state = baseState({
    phaseProgress: progress(baselineTasks),
    implementationRun: implementationRun({ kind: "empty", baseCommit: commits.base }),
  });
  const result = await value.run("execute-change-tasks", state);
  assert.equal(result.kind, "adopted");
  assert.equal(result.next, "inspect-phase-work");
  assert.equal(result.state.implementationRun, null);
  assert.match(result.summary, /implementation run Phase 2 прекращён: в фазе не осталось задач/u);
  workflowStateSchema.parse(result.state);
});

test("история задач между run и фазы начального планирования принимаются по репозиторию", async () => {
  const between = workspace({
    tasks: [task(1, "1.1", "Чтение", true), task(2, "1.2", "Схема")],
    phases: [1],
  });
  const previous = progress([task(1, "1.1", "Схема", true), task(2, "1.2", "Чтение", true)], [1], 2);
  const adopted = await between.run("inspect-phase-work", baseState({ phaseProgress: previous }));
  assert.equal(adopted.kind, "adopted");
  assert.deepEqual(
    adopted.state.phaseProgress.tasks.map(({ description, done }) => [description, done]),
    [["1.1 Чтение", true], ["1.2 Схема", false]],
  );
  assert.equal(adopted.state.phaseProgress.nextImplementationRun, 2);

  const initial = workspace({ tasks: [task(1, "1.1", "Схема"), task(2, "2.1", "Чтение")] });
  const planned = await initial.run("resolve-review-findings", baseState({ initialPlannedPhases: [1] }));
  assert.equal(planned.kind, "adopted");
  assert.deepEqual(planned.state.initialPlannedPhases, [1, 2]);
});

test("нечитаемый список задач останавливает workflow с настоящей причиной", async () => {
  const state = baseState({
    phaseProgress: progress(baselineTasks),
    implementationRun: implementationRun(collectingBatch),
    pendingTaskExecutionSession: taskSession(),
  });
  const unreadable = workspace({
    inspectTasks: () => {
      throw new PhaseWorkError("Задача 4.1 ссылается на неизвестную Phase 4");
    },
  });
  const result = await unreadable.run("execute-change-tasks", state);
  assert.equal(result.kind, "halt");
  assert.equal(result.summary, "Задача 4.1 ссылается на неизвестную Phase 4");
  assert.match(result.message, /исправьте артефакты change и нажмите «Повторить»/u);
  assert.deepEqual(unreadable.calls, ["inspect", "tasks"]);

  const broken = workspace({
    inspectTasks: () => {
      throw new Error("mise недоступен");
    },
  });
  await assert.rejects(broken.run("execute-change-tasks", state), /mise недоступен/u);
});

test("финальный gate публикует коммиты после архивного и не читает задачи", async () => {
  const session = {
    changeId,
    branch: changeBranch,
    baselineCommit: commits.first,
    sourcePath: `openspec/changes/${changeId}`,
    archivePath: `openspec/changes/archive/2026-10-02-${changeId}`,
    deltaSpecPaths: [],
    rootPullRequest: {
      number: 41,
      url: `${repository.url}/pull/41`,
      repositoryHost: repository.host,
      repositoryNameWithOwner: repository.nameWithOwner,
      repositoryUrl: repository.url,
      changeBranch,
    },
  };
  const state = baseState({
    phaseProgress: progress([task(1, "1.1", "Схема", true)], [1], 2),
    rootPullRequest: session.rootPullRequest,
    archivedChange: { session, commit: commits.second },
  });
  const value = workspace({
    head: commits.head,
    origin: { kind: "unpublished", remoteHead: commits.second, commits: 1 },
  });
  const result = await value.run("await-root-merge", state);
  assert.equal(result.kind, "adopted");
  assert.equal(result.next, "await-root-merge");
  assert.deepEqual(result.state, state);
  assert.deepEqual(value.calls, ["inspect", "publish:4..7"]);
});

test("переписанная история переносит run на общий предок после публикации пользователем", async () => {
  // Пользователь переписал коммиты пакета и сам опубликовал новую историю.
  const value = workspace({
    head: commits.head,
    ancestors: [commits.root, commits.head],
    mergeBases: { [commits.base]: commits.root, [commits.first]: commits.root },
  });
  const state = baseState({
    phaseProgress: progress(baselineTasks),
    implementationRun: implementationRun(collectingBatch),
  });
  const result = await value.run("execute-change-tasks", state);
  assert.equal(result.kind, "adopted");
  assert.deepEqual(result.state.implementationRun.batch, {
    kind: "collecting",
    baseCommit: commits.root,
    headCommit: commits.head,
    tasks: [{ taskId: "2", taskNumber: "2.1", commit: null }],
  });
  workflowStateSchema.parse(result.state);
});

test("сводка принятого состояния ограничена длиной текста действия", async () => {
  const long = "очень длинная причина ".repeat(40);
  const value = workspace({
    assessments: { taskExecution: { kind: "stale", reason: long } },
  });
  const state = baseState({
    phaseProgress: progress(baselineTasks),
    implementationRun: implementationRun(collectingBatch),
    pendingTaskExecutionSession: taskSession(),
  });
  const result = await value.run("execute-change-tasks", state);
  assert.equal(result.kind, "adopted");
  assert.equal(result.summary.length, 500);
  assert.ok(result.summary.endsWith("…"));
});
