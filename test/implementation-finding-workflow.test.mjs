import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPhaseWork,
  phaseTaskFingerprint,
} from "../server/phase-work.ts";
import {
  createResolveImplementationReviewFindingsStep,
} from "../server/workflow/steps/resolve-implementation-review-findings.ts";
import { createInitialWorkflowState } from "../server/workflow/types.ts";

const changeId = "implementation-findings";
const changeBranch = `change/${changeId}`;
const implementationBranch = changeBranch;
const hashes = Object.fromEntries(
  "abc".split("").map((key) => [key, key.repeat(40)]),
);

function task(number, done) {
  const id = `task-${number}`;
  const description = `${number} Задача ${number}`;
  return {
    id,
    number,
    description,
    done,
    phaseNumber: 1,
    fingerprint: phaseTaskFingerprint(id, number, description),
  };
}

function snapshot(tasks) {
  return {
    phases: [{ number: 1 }],
    tasks,
    schemaName: "spec-driven",
    planPath: `/repo/openspec/changes/${changeId}/plan.md`,
    taskArtifactPaths: [`/repo/openspec/changes/${changeId}/tasks.md`],
  };
}

const initialProgress = classifyPhaseWork(
  snapshot([task("1.1", false)]),
  null,
).progress;

const implementationRun = {
  changeId,
  changeBranch,
  implementationBranch,
  phaseNumber: 1,
  runNumber: 1,
  rootBaselineCommit: hashes.a,
  repository: {
    host: "github.com",
    nameWithOwner: "example/project",
    url: "https://github.com/example/project",
  },
  publication: {
    kind: "reviewed",
    number: 41,
    url: "https://github.com/example/project/pull/41",
    title: "Implementation",
  },
  batch: {
    kind: "reviewed",
    baseCommit: hashes.a,
    headCommit: hashes.b,
    reviewCommit: hashes.c,
    tasks: [{ taskId: "task-1.1", taskNumber: "1.1", commit: hashes.b }],
  },
};

async function runFindingTransition(mode) {
  const remediationSnapshot = snapshot([
    task("1.1", true),
    task("1.2", false),
  ]);
  let phaseInspections = 0;
  const step = createResolveImplementationReviewFindingsStep({
    workspaceDirectory: "/repo",
    readAgentProfiles: async () => [{
      id: "profile-high",
      name: "High",
      provider: "codex",
      model: "gpt-6-astra",
      modeId: "default",
      thinkingOptionId: "high",
    }],
    findingResolution: {
      async plan() {
        return mode === "completed"
          ? { kind: "finding-required", session: { findingId: "F1" } }
          : {
              kind: "no-findings",
              reviewPath: `/repo/openspec/changes/${changeId}/implementation-review.md`,
              headCommit: hashes.c,
            };
      },
      async run(request) {
        await request.onFindingResolved();
        return {
          findingId: "F1",
          commit: hashes.c,
          remainingFindingIds: [],
          pullRequest: {
            number: 41,
            url: "https://github.com/example/project/pull/41",
          },
        };
      },
    },
    implementationRunVerification: {
      async assertCurrent() {
        return hashes.c;
      },
    },
    phaseWork: {
      async inspect(_workspace, inspectedChangeId, previous) {
        assert.equal(inspectedChangeId, changeId);
        phaseInspections += 1;
        return classifyPhaseWork(remediationSnapshot, previous);
      },
    },
  });
  const context = {
    signal: new AbortController().signal,
    state: {
      ...createInitialWorkflowState(),
      change: { id: changeId },
      changeBranch,
      activeBranch: implementationBranch,
      phaseProgress: initialProgress,
      implementationRun,
    },
    updateActionLinks() {},
    async checkpointState() {},
    async notify() {
      return true;
    },
  };

  const result = await step.run(context);

  assert.equal(result.kind, "continue");
  assert.equal(result.next, "execute-change-tasks");
  assert.equal(phaseInspections, 1);
  assert.deepEqual(
    result.state.phaseProgress.tasks.map(({ number, done }) => ({ number, done })),
    [
      { number: "1.1", done: true },
      { number: "1.2", done: false },
    ],
  );
  assert.equal(
    classifyPhaseWork(
      snapshot([task("1.1", true), task("1.2", true)]),
      result.state.phaseProgress,
    ).kind,
    "change-complete",
  );
}

test("последняя implementation finding сохраняет новые задачи до их выполнения", async () => {
  await runFindingTransition("completed");
});

test("Retry после завершённой finding восстанавливает снимок новых задач", async () => {
  await runFindingTransition("recovered");
});
