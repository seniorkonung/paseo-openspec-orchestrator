import assert from "node:assert/strict";
import test from "node:test";
import { createAwaitImplementationMergeStep } from "../server/workflow/steps/await-implementation-merge.ts";
import { createInspectImplementationFeedbackStep } from "../server/workflow/steps/inspect-implementation-feedback.ts";
import { createInitialWorkflowState } from "../server/workflow/types.ts";

const changeId = "ci-workflow";
const run = {
  changeId,
  changeBranch: `change/${changeId}`,
  implementationBranch: `implementation/${changeId}/phase-1/run-1`,
  phaseNumber: 1,
  runNumber: 1,
  rootBaselineCommit: "a".repeat(40),
  repository: { host: "github.com", nameWithOwner: "example/project", url: "https://github.com/example/project" },
  publication: {
    kind: "ready-pr", number: 51, url: "https://github.com/example/project/pull/51", title: "Implementation",
  },
  batch: { kind: "empty", baseCommit: "b".repeat(40) },
  lastDeliveryHead: "b".repeat(40),
  processedFeedbackFingerprints: [],
};

function context(implementationRun = run) {
  return {
    signal: new AbortController().signal,
    state: { ...createInitialWorkflowState(), implementationRun },
    updateActionLinks() {},
    async checkpointState() {},
    async notify() { return true; },
  };
}

test("pending CI останавливает feedback gate до следующего Retry", async () => {
  const step = createInspectImplementationFeedbackStep({
    workspaceDirectory: "/workspace",
    pullRequest: {
      async inspectFeedback() { return { kind: "pending", checks: ["tests"] }; },
      async markReady() { throw new Error("Ready не должен выполняться"); },
    },
    feedbackReview: { async plan() { throw new Error("Аудит не должен запускаться"); } },
  });
  const result = await step.run(context({ ...run, publication: { ...run.publication, kind: "draft-pr" } }));
  assert.equal(result.kind, "halt");
  assert.match(result.summary, /tests/u);
});

test("красный CI на Ready gate возвращает run в Draft и останавливается", async () => {
  const awaitStep = createAwaitImplementationMergeStep({
    workspaceDirectory: "/workspace",
    pullRequest: { async inspectReadyGate() { return { kind: "blocked", checks: ["tests"] }; } },
    feedbackReview: { async plan() { throw new Error("Повторный аудит не нужен"); } },
    verifyChange: async () => {},
  });
  const transition = await awaitStep.run(context());
  assert.equal(transition.kind, "continue");
  assert.equal(transition.next, "inspect-implementation-feedback");
  assert.equal(transition.state.implementationRun.publication.kind, "draft-pr");

  const inspectStep = createInspectImplementationFeedbackStep({
    workspaceDirectory: "/workspace",
    pullRequest: { async inspectFeedback() { return { kind: "blocked", checks: ["tests"] }; } },
    feedbackReview: { async plan() { throw new Error("Повторный аудит не нужен"); } },
  });
  const result = await inspectStep.run(context(transition.state.implementationRun));
  assert.equal(result.kind, "halt");
  assert.match(result.summary, /не прошёл/u);
});
