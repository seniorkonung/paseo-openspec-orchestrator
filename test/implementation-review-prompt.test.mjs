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
  implementationBranch: "implementation/delegated-review/phase-1/run-1",
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
    reviewRepositoryPath: reviewPath,
    alreadyCommitted,
  });
}

test("ревью имплементации допускает субагентов в пределах заданного диапазона", () => {
  const result = prompt(false);
  const delegation = result.split("\n\n").find((paragraph) => paragraph.startsWith("You may spawn"));

  assert.ok(delegation);
  assert.match(delegation, /You may spawn review subagents/u);
  assert.ok(delegation.includes(`${baseCommit}..${reviewedHead}`));
  assert.match(delegation, /They may only inspect and report findings/u);
  assert.match(delegation, /Only you may write the report, create the review commit, push, and call `complete_implementation_review`/u);
  assert.match(result, /never create or archive workspaces or changes, and never invoke another workflow/u);
  assert.doesNotMatch(result, /never spawn or archive agents/u);
  assert.match(result, /never fix findings or implementation and never change task state/u);
});

test("восстановление ревью имплементации не запускает повторный анализ", () => {
  const result = prompt(true);

  assert.match(result, /This is a recovery session/u);
  assert.match(result, /Do not invoke the review skill, edit files, or create or amend a commit/u);
  assert.doesNotMatch(result, /You may spawn review subagents/u);
  assert.doesNotMatch(result, /never spawn or archive agents/u);
  assert.match(result, /never create or archive workspaces or changes, and never invoke another workflow/u);
  assert.match(result, /complete_implementation_review/u);
});
