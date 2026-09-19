import assert from "node:assert/strict";
import test from "node:test";
import {
  collectImplementationTask,
  implementationRunSchema,
} from "../server/implementation-run-model.ts";
import {
  IMPLEMENTATION_SUMMARY_END,
  IMPLEMENTATION_SUMMARY_START,
  renderImplementationSummary,
  replaceImplementationSummary,
} from "../server/implementation-publication.ts";

const changeId = "one-pull-request";
const base = "a".repeat(40);
const commit = "b".repeat(40);
const run = {
  changeId,
  changeBranch: `change/${changeId}`,
  implementationBranch: `implementation/${changeId}`,
  rootBaselineCommit: base,
  repository: {
    host: "github.com",
    nameWithOwner: "example/project",
    url: "https://github.com/example/project",
  },
  publication: { kind: "unpublished" },
  batch: { kind: "empty", baseCommit: base },
  lastDeliveryHead: null,
  processedFeedbackFingerprints: [],
};

test("run-state собирает task-коммиты в один ordered batch", () => {
  const first = collectImplementationTask(run, { taskId: "a", taskNumber: "1.1", commit });
  const second = collectImplementationTask(first, { taskId: "b", taskNumber: "1.2", commit: "c".repeat(40) });
  assert.equal(second.batch.kind, "collecting");
  assert.deepEqual(second.batch.tasks.map(({ taskNumber }) => taskNumber), ["1.1", "1.2"]);
  assert.equal(second.batch.baseCommit, base);
  assert.equal(second.batch.headCommit, "c".repeat(40));
});

test("run-state отклоняет ветки другого change и повторный commit", () => {
  assert.throws(() => implementationRunSchema.parse({ ...run, implementationBranch: "implementation/other" }));
  const first = collectImplementationTask(run, { taskId: "a", taskNumber: "1.1", commit });
  assert.throws(
    () => collectImplementationTask(first, { taskId: "b", taskNumber: "1.2", commit }),
    /повторяющийся commit/u,
  );
});

test("run-state не представляет reviewed без PR и Ready с непустым пакетом", () => {
  const task = { taskId: "a", taskNumber: "1.1", commit };
  assert.throws(() => implementationRunSchema.parse({
    ...run,
    batch: {
      kind: "reviewed",
      baseCommit: base,
      headCommit: commit,
      reviewCommit: "c".repeat(40),
      tasks: [task],
    },
    lastDeliveryHead: commit,
  }), /должен иметь единый implementation PR/u);
  assert.throws(() => implementationRunSchema.parse({
    ...run,
    publication: {
      kind: "ready-pr",
      number: 7,
      url: "https://github.com/example/project/pull/7",
      title: "Реализация",
    },
    batch: { kind: "collecting", baseCommit: base, headCommit: commit, tasks: [task] },
    lastDeliveryHead: commit,
  }), /Ready implementation PR требует пустой task-пакет/u);
});

test("managed summary сохраняет пользовательский текст и findings", () => {
  const original = `Пользовательский пролог\n\n${IMPLEMENTATION_SUMMARY_START}\nстарое\n${IMPLEMENTATION_SUMMARY_END}\n\n<!-- paseo-openspec-orchestrator:findings:start -->\n## Результаты устранения замечаний\n\nзапись\n<!-- paseo-openspec-orchestrator:findings:end -->`;
  const summary = renderImplementationSummary({ ...run, lastDeliveryHead: commit });
  const updated = replaceImplementationSummary(original, summary);
  assert.match(updated, /Пользовательский пролог/u);
  assert.match(updated, /Результаты устранения замечаний/u);
  assert.match(updated, new RegExp(commit, "u"));
  assert.throws(
    () => replaceImplementationSummary(`${IMPLEMENTATION_SUMMARY_START}\nбез конца`, summary),
    /повреждённ/u,
  );
});
