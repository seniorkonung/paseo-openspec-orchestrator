import assert from "node:assert/strict";
import test from "node:test";
import { createInspectPhaseWorkStep } from "../server/workflow/steps/inspect-phase-work.ts";
import { createInitialWorkflowState } from "../server/workflow/types.ts";
import { phaseTaskFingerprint } from "../server/phase-work.ts";

const changeId = "phase-change";
const changeBranch = `change/${changeId}`;
const identity = {
  number: 41,
  url: "https://github.com/example/project/pull/41",
  repositoryHost: "github.com",
  repositoryNameWithOwner: "example/project",
  repositoryUrl: "https://github.com/example/project",
  changeBranch,
};
const progress = {
  phases: [{ number: 1, fingerprint: "1".repeat(64) }],
  tasks: [{
    id: "task-a",
    number: "1.1",
    description: "1.1 Задача",
    done: true,
    fingerprint: phaseTaskFingerprint("task-a", "1.1", "1.1 Задача"),
  }],
  nextImplementationRun: 2,
};

function context() {
  return {
    signal: new AbortController().signal,
    state: {
      ...createInitialWorkflowState(),
      change: { id: changeId },
      changeBranch,
      activeBranch: changeBranch,
      phaseProgress: progress,
      rootPullRequest: identity,
    },
    updateActionLinks() {},
    async checkpointState() {},
    async notify() { return true; },
  };
}

test("полный change переходит к архивации до перевода root PR в Ready", async () => {
  let readyCalls = 0;
  const step = createInspectPhaseWorkStep({
    workspaceDirectory: "/repo",
    phaseWork: {
      async inspect() { return { kind: "change-complete", progress, snapshot: {} }; },
    },
    rootPullRequest: {
      async synchronize() { return "a".repeat(40); },
      async inspect() { return { kind: "open", isDraft: true, head: "a".repeat(40), identity }; },
      async makeDraft(_workspace, inspection) { return inspection; },
      async makeReady() {
        readyCalls += 1;
        return { kind: "open", isDraft: false, head: "a".repeat(40), identity };
      },
    },
  });
  const result = await step.run(context());
  assert.equal(result.kind, "continue");
  assert.equal(result.next, "archive-change");
  assert.equal(readyCalls, 0);
});

test("повторная проверка после Ready обнаруживает новую задачу и возвращает root PR в Draft", async () => {
  let inspections = 0;
  let draftCalls = 0;
  const nextProgress = {
    ...progress,
    tasks: [...progress.tasks, {
      id: "task-b",
      number: "1.2",
      description: "1.2 Новая задача",
      done: false,
      fingerprint: phaseTaskFingerprint("task-b", "1.2", "1.2 Новая задача"),
    }],
  };
  const step = createInspectPhaseWorkStep({
    workspaceDirectory: "/repo",
    phaseWork: {
      async inspect() {
        inspections += 1;
        return inspections === 1
          ? { kind: "change-complete", progress, snapshot: {} }
          : {
              kind: "implementation-required",
              phaseNumber: 1,
              runNumber: 2,
              progress: nextProgress,
              snapshot: {},
            };
      },
    },
    rootPullRequest: {
      async synchronize() { return "a".repeat(40); },
      async inspect() { return { kind: "open", isDraft: inspections === 0, head: "a".repeat(40), identity }; },
      async makeReady() { return { kind: "open", isDraft: false, head: "a".repeat(40), identity }; },
      async makeDraft() {
        draftCalls += 1;
        return { kind: "open", isDraft: true, head: "a".repeat(40), identity };
      },
    },
  });
  const result = await step.run(context());
  assert.equal(result.kind, "continue");
  assert.equal(result.next, "prepare-implementation-branch");
  assert.deepEqual(result.state.phaseTarget, { kind: "implementation", phaseNumber: 1, runNumber: 2 });
  assert.equal(result.state.phaseProgress.nextImplementationRun, 3);
  assert.equal(draftCalls, 1);
});

test("Retry обнаруживает новую фазу без задач и направляет её на planning в корневой ветке", async () => {
  let draftCalls = 0;
  const nextProgress = {
    ...progress,
    phases: [
      ...progress.phases,
      { number: 2, fingerprint: "2".repeat(64) },
    ],
  };
  const step = createInspectPhaseWorkStep({
    workspaceDirectory: "/repo",
    phaseWork: {
      async inspect() {
        return {
          kind: "planning-required",
          phaseNumber: 2,
          progress: nextProgress,
          snapshot: {},
        };
      },
    },
    rootPullRequest: {
      async synchronize() { return "a".repeat(40); },
      async inspect() {
        return { kind: "open", isDraft: false, head: "a".repeat(40), identity };
      },
      async makeReady(_workspace, inspection) { return inspection; },
      async makeDraft() {
        draftCalls += 1;
        return { kind: "open", isDraft: true, head: "a".repeat(40), identity };
      },
    },
  });
  const result = await step.run(context());
  assert.equal(result.kind, "continue");
  assert.equal(result.next, "prepare-phase-planning-branch");
  assert.deepEqual(result.state.phaseTarget, { kind: "planning", phaseNumber: 2 });
  assert.equal(draftCalls, 1);
});

test("merge root PR при оставшейся работе и CLOSED без merge останавливают workflow", async () => {
  for (const kind of ["merged", "closed"]) {
    const step = createInspectPhaseWorkStep({
      workspaceDirectory: "/repo",
      phaseWork: {
        async inspect() {
          return {
            kind: "implementation-required",
            phaseNumber: 1,
            runNumber: 2,
            progress: { ...progress, tasks: [{ ...progress.tasks[0], done: false }] },
            snapshot: {},
          };
        },
      },
      rootPullRequest: {
        async synchronize() { return "a".repeat(40); },
        async inspect() { return { kind, head: "a".repeat(40), identity }; },
        async makeReady() { throw new Error("не вызывается"); },
        async makeDraft() { throw new Error("не вызывается"); },
      },
    });
    const result = await step.run(context());
    assert.equal(result.kind, "halt");
  }
});

test("уже слитый PR без архива останавливается с объяснением", async () => {
  const step = createInspectPhaseWorkStep({
    workspaceDirectory: "/repo",
    phaseWork: { async inspect() { return { kind: "change-complete", progress, snapshot: {} }; } },
    rootPullRequest: {
      async synchronize() { return "a".repeat(40); },
      async inspect() { return { kind: "merged", head: "a".repeat(40), identity }; },
    },
  });
  const result = await step.run(context());
  assert.equal(result.kind, "halt");
  assert.match(result.summary, /без архивного коммита/u);
});
