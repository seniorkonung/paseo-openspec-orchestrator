import assert from "node:assert/strict";
import test from "node:test";
import {
  implementationReviewPrompt,
  pendingImplementationReviewSessionSchema,
} from "../server/implementation-review.ts";

const baseCommit = "a".repeat(40);
const reviewedHead = "b".repeat(40);
const reviewPath = "openspec/changes/delegated-review/implementation-review.md";
const session = pendingImplementationReviewSessionSchema.parse({
  changeId: "delegated-review",
  changeBranch: "change/delegated-review",
  implementationBranch: "change/delegated-review",
  rootBaselineCommit: baseCommit,
  baseCommit,
  reviewedHead,
  tasks: [{ taskId: "task-1", taskNumber: "1.1", commit: reviewedHead }],
  repository: {
    host: "github.com",
    nameWithOwner: "example/project",
    url: "https://github.com/example/project",
  },
});

function prompt(alreadyCommitted) {
  return implementationReviewPrompt({
    session,
    phaseNumber: 2,
    reviewRepositoryPath: reviewPath,
    alreadyCommitted,
    targetCommits: [reviewedHead],
  });
}

test("ревью имплементации допускает субагентов в пределах заданного диапазона", () => {
  const result = prompt(false);
  const delegation = result.split("\n\n").find((paragraph) => paragraph.startsWith("You may spawn"));

  assert.ok(delegation);
  assert.match(delegation, /You may spawn review subagents/u);
  assert.ok(delegation.includes(`${baseCommit}..${reviewedHead}`));
  assert.match(delegation, /They may only inspect and report findings/u);
  assert.match(delegation, /Only you may write the report, create the review commit, and call `complete_implementation_review`/u);
  assert.match(result, /Do not push or create a pull request/u);
  assert.match(result, /Stay within this stage's role: do only the work this prompt assigns[^.]*\. Never create or archive workspaces or changes, and never invoke another workflow/u);
  assert.doesNotMatch(result, /never spawn or archive agents/u);
  assert.match(result, /Follow the review skill/u);
  assert.doesNotMatch(result, /Modify only|never fix findings|never change task state|commit only the report/u);
});

test("ревью имплементации добавляет задачи только в текущую фазу или в новую фазу после неё", () => {
  const result = prompt(false);

  assert.match(result, /"phaseNumber":2/u);
  assert.match(result, /Add new tasks only to Phase 2 or to a new phase of your own/u);
  assert.match(result, /task IDs, numbers, descriptions, and order stay the same/u);
  assert.match(result, /strictly in file order\. Append the new tasks in the order they must run/u);
  assert.match(result, /Number new Phase 2 tasks as 2\.<next free number>/u);
  assert.match(result, /Never add tasks to another existing phase/u);
  assert.match(result, /The orchestrator plans every phase that has no tasks/u);
  assert.match(
    result,
    /insert its heading in plan\.md right after Phase 2 with a number greater than every existing phase number, keep every existing phase number unchanged/u,
  );
  assert.doesNotMatch(prompt(true), /Add new tasks only/u);
});

test("ревью имплементации завершает фазу и только оно запускает полные проверки", () => {
  const result = prompt(false);

  assert.match(result, /Every task of Phase 2 is complete, so this session completes that plan\.md phase/u);
  assert.match(result, /after your last code correction, run the full checks the repository requires before completing a phase/u);
  assert.doesNotMatch(result, /never run tests|never run the full checks/u);

  const recovered = prompt(true);
  assert.match(recovered, /changes no implementation code and does not complete a plan\.md phase: never run tests, builds, or project checks/u);
  assert.doesNotMatch(recovered, /so this session completes that plan\.md phase/u);
});

test("восстановление ревью имплементации не запускает повторный анализ", () => {
  const result = prompt(true);

  assert.match(result, /This is a recovery session/u);
  assert.match(result, /Do not invoke the review skill, edit files, or create or amend a commit/u);
  assert.doesNotMatch(result, /You may spawn review subagents/u);
  assert.doesNotMatch(result, /never spawn or archive agents/u);
  assert.match(result, /Stay within this stage's role: do only the work this prompt assigns[^.]*\. Never create or archive workspaces or changes, and never invoke another workflow/u);
  assert.match(result, /complete_implementation_review/u);
});
