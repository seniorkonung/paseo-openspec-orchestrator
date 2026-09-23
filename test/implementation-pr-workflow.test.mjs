import assert from "node:assert/strict";
import test from "node:test";
import { createAwaitImplementationMergeStep } from "../server/workflow/steps/await-implementation-merge.ts";
import { createInspectImplementationFeedbackStep } from "../server/workflow/steps/inspect-implementation-feedback.ts";
import { createInitialWorkflowState } from "../server/workflow/types.ts";

const changeId = "pr-workflow";
const url = "https://github.com/example/project/pull/51";
const run = {
  changeId,
  changeBranch: `change/${changeId}`,
  implementationBranch: `implementation/${changeId}/phase-1/run-1`,
  phaseNumber: 1,
  runNumber: 1,
  rootBaselineCommit: "a".repeat(40),
  repository: { host: "github.com", nameWithOwner: "example/project", url: "https://github.com/example/project" },
  publication: { kind: "draft-pr", number: 51, url, title: "Implementation" },
  batch: { kind: "empty", baseCommit: "b".repeat(40) },
  lastDeliveryHead: "b".repeat(40),
  processedFeedbackFingerprints: [],
};

function context(implementationRun = run) {
  const actionLinks = [];
  return {
    actionLinks,
    signal: new AbortController().signal,
    state: { ...createInitialWorkflowState(), implementationRun },
    updateActionLinks(links) { actionLinks.push(...links); },
    async checkpointState() {},
  };
}

const link = { kind: "external", url, label: "PR реализации #51" };

test("чистый Draft PR сразу переходит в Ready и сохраняет ссылку", async () => {
  const calls = [];
  const step = createInspectImplementationFeedbackStep({
    workspaceDirectory: "/workspace",
    pullRequest: {
      async inspectFeedback() { calls.push("inspect"); return { kind: "clean" }; },
      async markReady() { calls.push("ready"); return { kind: "clean" }; },
    },
    feedbackReview: { async plan() { throw new Error("Аудит не нужен"); } },
  });
  const execution = context();
  const result = await step.run(execution);
  assert.deepEqual(calls, ["inspect", "ready"]);
  assert.equal(result.kind, "continue");
  assert.equal(result.next, "await-implementation-merge");
  assert.equal(result.state.implementationRun.publication.kind, "ready-pr");
  assert.deepEqual(execution.actionLinks, [link]);
});

test("открытый Ready PR ожидает merge со ссылкой для перехода", async () => {
  const step = createAwaitImplementationMergeStep({
    workspaceDirectory: "/workspace",
    pullRequest: { async inspectReadyGate() { return { kind: "open", url, number: 51 }; } },
    feedbackReview: { async plan() { throw new Error("Аудит не нужен"); } },
    verifyChange: async () => {},
  });
  const execution = context({ ...run, publication: { ...run.publication, kind: "ready-pr" } });
  const result = await step.run(execution);
  assert.equal(result.kind, "halt");
  assert.match(result.message, /merge/u);
  assert.deepEqual(execution.actionLinks, [link]);
});
