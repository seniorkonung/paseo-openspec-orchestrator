import assert from "node:assert/strict";
import test from "node:test";
import { mergeManagedSummary } from "../server/change-publication-gateway.ts";
import {
  clearImplementationBatch,
  collectImplementationTask,
  implementationRunSchema,
} from "../server/implementation-run-model.ts";

const changeId = "one-pull-request";
const branch = `change/${changeId}`;
const base = "a".repeat(40);
const commit = "b".repeat(40);
const run = {
  changeId,
  changeBranch: branch,
  implementationBranch: branch,
  phaseNumber: 1,
  runNumber: 1,
  rootBaselineCommit: base,
  repository: {
    host: "github.com",
    nameWithOwner: "example/project",
    url: "https://github.com/example/project",
  },
  publication: { kind: "unreviewed" },
  batch: { kind: "empty", baseCommit: base },
};

test("run-state собирает task-коммиты в проверяемый пакет", () => {
  const first = collectImplementationTask(run, { taskId: "a", taskNumber: "1.1", commit });
  const second = collectImplementationTask(first, { taskId: "b", taskNumber: "1.2", commit: "c".repeat(40) });
  assert.equal(second.batch.kind, "collecting");
  assert.deepEqual(second.batch.tasks.map(({ taskNumber }) => taskNumber), ["1.1", "1.2"]);
  assert.equal(second.batch.baseCommit, base);
  assert.equal(second.batch.headCommit, "c".repeat(40));
  assert.throws(() => collectImplementationTask(first, { taskId: "b", taskNumber: "1.2", commit }), /повторяющийся commit/u);
});

test("run-state связывает review с корневым PR и сохраняет baseline нового пакета", () => {
  const task = { taskId: "a", taskNumber: "1.1", commit };
  const reviewedBatch = {
    kind: "reviewed", baseCommit: base, headCommit: commit,
    reviewCommit: "c".repeat(40), tasks: [task],
  };
  assert.throws(() => implementationRunSchema.parse({ ...run, batch: reviewedBatch }), /корневому PR/u);
  const reviewed = implementationRunSchema.parse({
    ...run,
    batch: reviewedBatch,
    publication: {
      kind: "reviewed", number: 7,
      url: "https://github.com/example/project/pull/7",
      title: "Изменение",
    },
  });
  const next = clearImplementationBatch(reviewed, "d".repeat(40));
  assert.deepEqual(next.batch, { kind: "empty", baseCommit: "d".repeat(40) });
  assert.equal(next.publication.number, 7);
  assert.throws(() => implementationRunSchema.parse({ ...run, implementationBranch: "change/other" }));
});

test("управляемая сводка корневого PR сохраняет пользовательский текст и findings", () => {
  const findings = "<!-- paseo-openspec-orchestrator:findings:start -->\nРезультаты\n<!-- paseo-openspec-orchestrator:findings:end -->";
  const first = mergeManagedSummary(`Текст пользователя\n\n${findings}`, "## Суть\nПервый вариант");
  const second = mergeManagedSummary(first, "## Суть\nИсправленный вариант");
  assert.match(second, /Текст пользователя/u);
  assert.match(second, /Результаты/u);
  assert.match(second, /Исправленный вариант/u);
  assert.doesNotMatch(second, /Первый вариант/u);
  assert.throws(() => mergeManagedSummary("<!-- paseo-openspec-orchestrator:summary:start -->", "новое"), /повреждена/u);
});
