import assert from "node:assert/strict";
import test from "node:test";
import { reanchorImplementationRun } from "../server/implementation-run-reconciliation.ts";
import { rebasePhaseProgress } from "../server/phase-progress-adoption.ts";
import { phaseTaskFingerprint } from "../server/phase-work.ts";

const changeId = "reanchored-change";
const branch = `change/${changeId}`;
const commits = Object.fromEntries(
  ["root", "base", "first", "second", "head", "rewritten", "review"].map((name, index) => [
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

function progress(tasks) {
  return {
    phases: [{ number: 1 }, { number: 2 }],
    tasks: tasks.map(({ id, number, description, done, fingerprint }) => ({
      id, number, description, done, fingerprint,
    })),
    nextImplementationRun: 3,
  };
}

function run(batch, publication = { kind: "unreviewed" }) {
  return {
    changeId,
    changeBranch: branch,
    implementationBranch: branch,
    phaseNumber: 2,
    runNumber: 2,
    rootBaselineCommit: commits.root,
    repository: { host: "github.com", nameWithOwner: "example/project", url: "https://github.com/example/project" },
    publication,
    batch,
  };
}

/** История, в которой перечисленные коммиты остаются предками HEAD. */
function history(ancestors, mergeBases = {}) {
  const known = new Set(ancestors);
  return (commit) => (known.has(commit) ? commit : mergeBases[commit] ?? null);
}

// Начало пакета: Phase 1 завершена, в Phase 2 три невыполненные задачи.
const baselineTasks = [
  task(1, "1.1", "Схема", true),
  task(2, "2.1", "Чтение"),
  task(3, "2.2", "Оболочка"),
  task(4, "2.3", "Замена вставок"),
];
const baseline = progress(baselineTasks);
const collecting = run({
  kind: "collecting",
  baseCommit: commits.base,
  headCommit: commits.first,
  tasks: [{ taskId: "2", taskNumber: "2.1", commit: commits.first }],
});
const afterFirstTask = [
  task(1, "1.1", "Схема", true),
  task(2, "2.1", "Чтение", true),
  task(3, "2.2", "Оболочка"),
  task(4, "2.3", "Замена вставок"),
];

function reanchor(overrides) {
  return reanchorImplementationRun({
    run: collecting,
    previousBaseline: baseline,
    baseline,
    tasks: afterFirstTask,
    head: commits.first,
    nearestAncestor: history([commits.root, commits.base, commits.first]),
    ...overrides,
  });
}

test("run, соответствующий репозиторию, не меняется", () => {
  const result = reanchor({});
  assert.deepEqual(result.notes, []);
  assert.deepEqual(result.run, collecting);
});

test("посторонние коммиты после задачи продолжают пакет до HEAD", () => {
  const result = reanchor({
    head: commits.head,
    nearestAncestor: history([commits.root, commits.base, commits.first, commits.head]),
  });
  assert.deepEqual(result.notes, ["пакет implementation продолжен до текущего HEAD"]);
  assert.deepEqual(result.run.batch, { ...collecting.batch, headCommit: commits.head });
});

test("перестановка невыполненных задач сохраняет пакет выполненных", () => {
  const reordered = [
    task(1, "1.1", "Схема", true),
    task(2, "2.1", "Чтение", true),
    task(3, "2.2", "Замена вставок"),
    task(4, "2.3", "Оболочка"),
  ];
  const result = reanchor({
    baseline: rebasePhaseProgress(baseline, { phases: baseline.phases, tasks: reordered }),
    tasks: reordered,
    head: commits.head,
    nearestAncestor: history([commits.root, commits.base, commits.first, commits.head]),
  });
  assert.deepEqual(result.run.batch, { ...collecting.batch, headCommit: commits.head });
  assert.deepEqual(result.notes, ["пакет implementation продолжен до текущего HEAD"]);
});

test("перенумерованная выполненная задача остаётся в пакете под новым номером", () => {
  const renumbered = [
    task(1, "1.1", "Схема", true),
    task(2, "2.1", "Замена вставок"),
    task(3, "2.2", "Чтение", true),
    task(4, "2.3", "Оболочка"),
  ];
  const result = reanchor({
    baseline: rebasePhaseProgress(baseline, { phases: baseline.phases, tasks: renumbered }),
    tasks: renumbered,
  });
  assert.deepEqual(result.run.batch.tasks, [
    { taskId: "3", taskNumber: "2.2", commit: commits.first },
  ]);
  assert.deepEqual(result.notes, ["задачи пакета сопоставлены с изменённым списком задач"]);
});

test("снова открытая задача выходит из пакета, а коммиты остаются под его baseline", () => {
  const reopened = [
    task(1, "1.1", "Схема", true),
    task(2, "2.1", "Чтение"),
    task(3, "2.2", "Оболочка"),
    task(4, "2.3", "Замена вставок"),
  ];
  const result = reanchor({
    tasks: reopened,
    head: commits.head,
    nearestAncestor: history([commits.root, commits.base, commits.first, commits.head]),
  });
  assert.deepEqual(result.run.batch, { kind: "empty", baseCommit: commits.base });
  assert.deepEqual(result.notes, [
    "из пакета исключены задачи, которых нет среди завершённых задач фазы: 2.1",
  ]);
});

test("задача, завершённая вне task-сессии, попадает в пакет без границы коммитов", () => {
  const completedByHand = [
    task(1, "1.1", "Схема", true),
    task(2, "2.1", "Чтение", true),
    task(3, "2.2", "Оболочка", true),
    task(4, "2.3", "Замена вставок"),
  ];
  const fromCollecting = reanchor({
    tasks: completedByHand,
    head: commits.head,
    nearestAncestor: history([commits.root, commits.base, commits.first, commits.head]),
  });
  assert.deepEqual(fromCollecting.run.batch.tasks, [
    { taskId: "2", taskNumber: "2.1", commit: commits.first },
    { taskId: "3", taskNumber: "2.2", commit: null },
  ]);
  assert.deepEqual(fromCollecting.notes, [
    "в пакет добавлены задачи, завершённые вне task-сессии: 2.2",
    "пакет implementation продолжен до текущего HEAD",
  ]);

  // Пустой пакет становится проверяемым, когда единственная задача завершена вручную.
  const fromEmpty = reanchor({
    run: run({ kind: "empty", baseCommit: commits.base }),
    tasks: afterFirstTask,
    head: commits.first,
  });
  assert.deepEqual(fromEmpty.run.batch, {
    kind: "collecting",
    baseCommit: commits.base,
    headCommit: commits.first,
    tasks: [{ taskId: "2", taskNumber: "2.1", commit: null }],
  });
});

test("пустой пакет без завершённых задач сохраняет baseline для посторонних коммитов", () => {
  const result = reanchor({
    run: run({ kind: "empty", baseCommit: commits.base }),
    tasks: baselineTasks,
    head: commits.head,
    nearestAncestor: history([commits.root, commits.base, commits.head]),
  });
  assert.deepEqual(result.notes, []);
  assert.deepEqual(result.run.batch, { kind: "empty", baseCommit: commits.base });
});

test("переписанная история переносит baseline на общий предок и теряет границу задачи", () => {
  const result = reanchor({
    head: commits.rewritten,
    // Коммиты base и first переписаны: общий предок с новой историей — root.
    nearestAncestor: history([commits.root, commits.rewritten], {
      [commits.base]: commits.root,
      [commits.first]: commits.root,
    }),
  });
  assert.deepEqual(result.run.batch, {
    kind: "collecting",
    baseCommit: commits.root,
    headCommit: commits.rewritten,
    tasks: [{ taskId: "2", taskNumber: "2.1", commit: null }],
  });
  assert.deepEqual(result.notes, [
    "baseline пакета перенесён на общий предок с текущей историей",
    "завершающие коммиты задач 2.1 исчезли из истории",
    "пакет implementation продолжен до текущего HEAD",
  ]);

  // Истории без общего предка: baseline run и пакета переносятся на HEAD.
  const unrelated = reanchor({ head: commits.rewritten, nearestAncestor: history([commits.rewritten]) });
  assert.equal(unrelated.run.rootBaselineCommit, commits.rewritten);
  assert.deepEqual(unrelated.run.batch, { kind: "empty", baseCommit: commits.rewritten });
});

test("пакет без коммитов после baseline остаётся пустым и не повторяет заметки", () => {
  // Задача отмечена завершённой до baseline пакета, а baseline задач снят раньше.
  const unchanged = reanchor({
    run: run({ kind: "empty", baseCommit: commits.first }),
    tasks: afterFirstTask,
    head: commits.first,
  });
  assert.deepEqual(unchanged.notes, []);
  assert.deepEqual(unchanged.run.batch, { kind: "empty", baseCommit: commits.first });

  // Ветка возвращена к baseline пакета, а задача осталась завершённой.
  const emptied = reanchor({
    head: commits.base,
    nearestAncestor: history([commits.root, commits.base]),
  });
  assert.deepEqual(emptied.run.batch, { kind: "empty", baseCommit: commits.base });
  assert.deepEqual(emptied.notes, [
    "пакет implementation опустошён: после его baseline не осталось коммитов",
  ]);
});

test("проверенный пакет не сверяется с историей и ждёт устранения findings", () => {
  const publication = {
    kind: "reviewed", number: 41, url: "https://github.com/example/project/pull/41", title: "Change",
  };
  const reviewed = run({
    kind: "reviewed",
    baseCommit: commits.base,
    headCommit: commits.first,
    reviewCommit: commits.review,
    tasks: [{ taskId: "2", taskNumber: "2.1", commit: commits.first }],
  }, publication);
  const kept = reanchor({
    run: reviewed,
    head: commits.head,
    nearestAncestor: history([commits.root, commits.base, commits.first, commits.review, commits.head]),
  });
  assert.deepEqual(kept.notes, []);
  assert.deepEqual(kept.run, reviewed);

  // Коммиты пакета переписаны: запись о review остаётся прежней, а baseline
  // run переносится, чтобы finding-этап продолжал текущую историю.
  const rewritten = reanchor({
    run: reviewed,
    head: commits.rewritten,
    nearestAncestor: history([commits.rewritten], { [commits.root]: commits.second }),
  });
  assert.deepEqual(rewritten.run.batch, reviewed.batch);
  assert.equal(rewritten.run.rootBaselineCommit, commits.second);
  assert.deepEqual(rewritten.notes, ["baseline run перенесён на общий предок с текущей историей"]);
});
