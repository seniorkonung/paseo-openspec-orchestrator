import assert from "node:assert/strict";
import test from "node:test";
import { REQUIRED_AGENT_PROFILE_NAMES } from "../server/agent-profiles.ts";
import {
  PhaseWorkError,
  classifyPhaseWork,
  phaseTaskFingerprint,
} from "../server/phase-work.ts";
import { createResolveReviewFindingsStep } from "../server/workflow/steps/resolve-review-findings.ts";
import { createReviewChangeStep } from "../server/workflow/steps/review-change.ts";
import { createReviewImplementationStep } from "../server/workflow/steps/review-implementation.ts";
import { workflowTaskScope } from "../server/workflow/task-scope.ts";
import { createInitialWorkflowState } from "../server/workflow/types.ts";

const changeId = "task-scope";
const changeBranch = `change/${changeId}`;
const hashes = Object.fromEntries("abcd".split("").map((key) => [key, key.repeat(40)]));
const repository = {
  host: "github.com",
  nameWithOwner: "example/project",
  url: "https://github.com/example/project",
};
const pullRequest = { number: 41, url: "https://github.com/example/project/pull/41" };

function profiles() {
  return REQUIRED_AGENT_PROFILE_NAMES.map((name) => ({
    id: `profile-${name.toLowerCase().replaceAll(" ", "-")}`,
    name,
    provider: "codex",
    model: "gpt-6-astra",
    modeId: "default",
    thinkingOptionId: "high",
  }));
}

function task(number, done = false) {
  const id = `task-${number}`;
  const description = `${number} Задача ${number}`;
  return {
    id,
    number,
    description,
    done,
    phaseNumber: Number(number.split(".")[0]),
    fingerprint: phaseTaskFingerprint(id, number, description),
  };
}

function phaseDecision(tasks, previous = null) {
  return classifyPhaseWork({
    phases: [{ number: 1 }, { number: 2 }],
    tasks,
    schemaName: "spec-driven",
    planPath: `/repo/openspec/changes/${changeId}/plan.md`,
    taskArtifactPaths: [`/repo/openspec/changes/${changeId}/tasks.md`],
  }, previous);
}

const implementationBaseline = phaseDecision([task("1.1")]).progress;
const planningRun = {
  changeId,
  changeBranch,
  planningBranch: changeBranch,
  phaseNumber: 2,
  rootBaselineCommit: hashes.a,
  baselineProgress: phaseDecision([task("1.1", true)]).progress,
};
const implementationRun = {
  changeId,
  changeBranch,
  implementationBranch: changeBranch,
  phaseNumber: 1,
  runNumber: 1,
  rootBaselineCommit: hashes.a,
  repository,
  publication: { kind: "unreviewed" },
  batch: {
    kind: "collecting",
    baseCommit: hashes.a,
    headCommit: hashes.b,
    tasks: [{ taskId: "task-1.1", taskNumber: "1.1", commit: hashes.b }],
  },
};

function initialState(overrides = {}) {
  return {
    ...createInitialWorkflowState(),
    change: { id: changeId },
    changeBranch,
    activeBranch: changeBranch,
    ...overrides,
  };
}

function stepContext(state) {
  const checkpoints = [];
  return {
    checkpoints,
    context: {
      signal: new AbortController().signal,
      state,
      updateActionLinks() {},
      async checkpointState(nextState) {
        checkpoints.push(nextState);
      },
      async notify() {
        return true;
      },
    },
  };
}

function reviewSession(phaseNumber) {
  return {
    changeId,
    phaseNumber,
    parentBranch: changeBranch,
    reviewBranch: changeBranch,
    parentBaselineCommit: hashes.a,
    baselineCommit: hashes.a,
    repositoryHost: repository.host,
    repositoryNameWithOwner: repository.nameWithOwner,
    repositoryUrl: repository.url,
    parentPullRequestNumber: 41,
  };
}

function reviewChangeStep({ inspect, runs, plans = [] }) {
  return createReviewChangeStep({
    workspaceDirectory: "/repo",
    readAgentProfiles: async () => profiles(),
    phaseWork: { inspect },
    changeReview: {
      async plan(_workspace, _changeId, _changeBranch, _activeBranch, phaseNumber) {
        plans.push(phaseNumber);
        return reviewSession(phaseNumber);
      },
      async run(request) {
        runs.push(request);
        return {
          changeId,
          reviewPath: `openspec/changes/${changeId}/review.md`,
          branch: changeBranch,
          pullRequest: { ...pullRequest, title: "Review" },
        };
      },
    },
  });
}

test("начальный review сохраняет фазы с задачами и передаёт их агенту", async () => {
  const inspections = [];
  const runs = [];
  const plans = [];
  const step = reviewChangeStep({
    async inspect(workspace, inspectedChangeId, previous) {
      assert.equal(workspace, "/repo");
      assert.equal(inspectedChangeId, changeId);
      inspections.push(previous);
      return phaseDecision([task("1.1")]);
    },
    runs,
    plans,
  });
  const { context, checkpoints } = stepContext(initialState());

  const result = await step.run(context);

  assert.equal(result.kind, "continue");
  assert.equal(result.next, "resolve-review-findings");
  assert.deepEqual(inspections, [null]);
  assert.deepEqual(plans, [null]);
  // Checkpoint с сессией строится от актуального состояния и не теряет baseline.
  assert.deepEqual(checkpoints.map(({ initialPlannedPhases }) => initialPlannedPhases), [[1], [1]]);
  assert.equal(checkpoints[1].pendingReviewSession.changeId, changeId);
  assert.deepEqual(runs[0].taskScope, { kind: "initial-planning", plannedPhases: [1] });
});

test("повторный review и review планирования фазы не снимают baseline заново", async () => {
  const runs = [];
  const step = reviewChangeStep({
    async inspect() {
      throw new Error("baseline уже сохранён");
    },
    runs,
  });

  const retry = stepContext(initialState({
    initialPlannedPhases: [1],
    pendingReviewSession: reviewSession(null),
  }));
  assert.equal((await step.run(retry.context)).kind, "continue");
  assert.deepEqual(retry.checkpoints, []);
  assert.deepEqual(runs[0].taskScope, { kind: "initial-planning", plannedPhases: [1] });

  const planning = stepContext(initialState({ planningRun }));
  assert.equal((await step.run(planning.context)).kind, "continue");
  assert.deepEqual(planning.checkpoints.map(({ initialPlannedPhases }) => initialPlannedPhases), [null]);
  assert.deepEqual(runs[1].taskScope, {
    kind: "phase-planning",
    phaseNumber: 2,
    baseline: planningRun.baselineProgress,
  });
});

test("некорректная структура задач останавливает начальный review до агента", async () => {
  const runs = [];
  const plans = [];
  const step = reviewChangeStep({
    async inspect() {
      throw new PhaseWorkError("Phase 2 содержит задачи после нераспланированной Phase 1");
    },
    runs,
    plans,
  });
  const { context, checkpoints } = stepContext(initialState());

  const result = await step.run(context);

  assert.equal(result.kind, "halt");
  assert.equal(result.summary, "Phase 2 содержит задачи после нераспланированной Phase 1");
  assert.deepEqual(plans, []);
  assert.deepEqual(runs, []);
  assert.deepEqual(checkpoints, []);
});

function resolveReviewFindingsStep({ inspect, plan, runs = [], verifications = [] }) {
  return createResolveReviewFindingsStep({
    workspaceDirectory: "/repo",
    readAgentProfiles: async () => profiles(),
    phaseWork: { inspect },
    implementationRunVerification: {
      async assertCurrent(_workspace, run) {
        verifications.push(run.phaseNumber);
        return hashes.b;
      },
    },
    findingResolution: {
      plan,
      async run(request) {
        runs.push(request);
        await request.onFindingResolved();
        return {
          findingId: request.session.findingId,
          commit: hashes.c,
          remainingFindingIds: request.session.findingId === "F1" ? ["F2"] : [],
          outcome: "resolved",
          pullRequest,
        };
      },
    },
  });
}

function findingPlan(findingId) {
  return async () => ({
    kind: "finding-required",
    findingId,
    session: { changeId, branch: changeBranch, findingId, baselineCommit: hashes.a },
  });
}

test("начальные findings переходят к проверке фаз, только если фазы оркестратора остались без задач", async () => {
  let tasks = [task("1.1")];
  const inspections = [];
  const step = resolveReviewFindingsStep({
    async inspect(_workspace, _changeId, previous) {
      inspections.push(previous);
      return phaseDecision(tasks);
    },
    async plan() {
      return {
        kind: "no-findings",
        reviewPath: `openspec/changes/${changeId}/review.md`,
        headCommit: hashes.a,
      };
    },
  });

  const passed = await step.run(stepContext(initialState({ initialPlannedPhases: [1] })).context);
  assert.equal(passed.kind, "continue");
  assert.equal(passed.next, "inspect-phase-work");
  assert.equal(passed.state.initialPlannedPhases, null);

  tasks = [task("1.1"), task("2.1")];
  const halted = await step.run(stepContext(initialState({ initialPlannedPhases: [1] })).context);
  assert.equal(halted.kind, "halt");
  assert.match(
    halted.summary,
    /До первой проверки фаз задачи можно добавлять только в фазы, где они уже были: Phase 1\. Задачи 2\.1 нарушают это правило/u,
  );
  assert.deepEqual(inspections, [null, null]);
});

test("findings начального планирования сохраняют снятый baseline в каждом checkpoint", async () => {
  const runs = [];
  const step = resolveReviewFindingsStep({
    async inspect() {
      return phaseDecision([task("1.1")]);
    },
    plan: findingPlan("F1"),
    runs,
  });
  const { context, checkpoints } = stepContext(initialState());

  const result = await step.run(context);

  assert.equal(result.kind, "continue");
  assert.equal(result.next, "resolve-review-findings");
  assert.deepEqual(runs[0].taskScope, { kind: "initial-planning", plannedPhases: [1] });
  assert.deepEqual(
    checkpoints.map(({ initialPlannedPhases, pendingFindingResolutionSession }) => ({
      initialPlannedPhases,
      findingId: pendingFindingResolutionSession?.findingId ?? null,
    })),
    [
      { initialPlannedPhases: [1], findingId: null },
      { initialPlannedPhases: [1], findingId: "F1" },
      { initialPlannedPhases: [1], findingId: null },
    ],
  );
});

test("findings внутри run получают область своего run и не снимают baseline начального планирования", async () => {
  const runs = [];
  const verifications = [];
  const step = resolveReviewFindingsStep({
    async inspect() {
      throw new Error("baseline run уже сохранён");
    },
    plan: findingPlan("F2"),
    runs,
    verifications,
  });

  const implementation = await step.run(stepContext(initialState({
    implementationRun,
    phaseProgress: implementationBaseline,
  })).context);
  assert.equal(implementation.kind, "continue");
  assert.equal(implementation.next, "resolve-implementation-review-findings");
  assert.deepEqual(runs[0].taskScope, {
    kind: "implementation",
    phaseNumber: 1,
    baseline: implementationBaseline,
  });
  assert.deepEqual(verifications, [1, 1]);

  const planning = await step.run(stepContext(initialState({ planningRun })).context);
  assert.equal(planning.kind, "continue");
  assert.equal(planning.next, "resolve-implementation-review-findings");
  assert.deepEqual(runs[1].taskScope, {
    kind: "phase-planning",
    phaseNumber: 2,
    baseline: planningRun.baselineProgress,
  });
});

test("implementation review получает baseline задач своего run", async () => {
  const runs = [];
  const step = createReviewImplementationStep({
    workspaceDirectory: "/repo",
    readAgentProfiles: async () => profiles(),
    implementationReview: {
      async plan(_workspace, run) {
        return {
          changeId,
          changeBranch,
          implementationBranch: changeBranch,
          rootBaselineCommit: run.rootBaselineCommit,
          baseCommit: run.batch.baseCommit,
          reviewedHead: run.batch.headCommit,
          tasks: run.batch.tasks,
          repository,
        };
      },
      async run(request) {
        runs.push(request);
        return {
          changeId,
          branch: changeBranch,
          baseCommit: request.session.baseCommit,
          reviewedHead: request.session.reviewedHead,
          reviewCommit: hashes.c,
          pullRequest: { ...pullRequest, title: "Implementation" },
        };
      },
    },
  });

  const reviewed = await step.run(stepContext(initialState({
    implementationRun,
    phaseProgress: implementationBaseline,
  })).context);
  assert.equal(reviewed.kind, "continue");
  assert.equal(runs[0].taskBaseline, implementationBaseline);

  const halted = await step.run(stepContext(initialState({ implementationRun })).context);
  assert.equal(halted.kind, "halt");
  assert.equal(halted.summary, "Не сохранён baseline задач implementation-run");
  assert.equal(runs.length, 1);
});

test("область задач следует стадии workflow", () => {
  assert.deepEqual(workflowTaskScope(initialState({ initialPlannedPhases: [1] })), {
    kind: "initial-planning",
    plannedPhases: [1],
  });
  assert.throws(
    () => workflowTaskScope(initialState()),
    /Не сохранены фазы с задачами начального планирования/u,
  );
  assert.deepEqual(workflowTaskScope(initialState({ planningRun })), {
    kind: "phase-planning",
    phaseNumber: 2,
    baseline: planningRun.baselineProgress,
  });
  assert.deepEqual(
    workflowTaskScope(initialState({ implementationRun, phaseProgress: implementationBaseline })),
    { kind: "implementation", phaseNumber: 1, baseline: implementationBaseline },
  );
  assert.throws(
    () => workflowTaskScope(initialState({ implementationRun })),
    /Не сохранён baseline задач implementation-run/u,
  );
});

test("review findings сначала собирают решения пользователя, а препятствие возвращает finding в следующий раунд", async () => {
  const decisionSession = {
    changeId,
    branch: changeBranch,
    findingIds: ["F1", "F2"],
    baselineCommit: hashes.a,
  };
  let planned = { kind: "decisions-required", session: decisionSession };
  const decideRequests = [];
  const step = createResolveReviewFindingsStep({
    workspaceDirectory: "/repo",
    readAgentProfiles: async () => profiles(),
    phaseWork: {
      async inspect() {
        return phaseDecision([task("1.1")]);
      },
    },
    implementationRunVerification: { async assertCurrent() { return hashes.b; } },
    findingResolution: {
      async plan() {
        return planned;
      },
      async decide(request) {
        decideRequests.push(request);
        await request.onDecisionsRecorded();
        return {
          changeId,
          commit: hashes.b,
          decisions: [
            { findingId: "F1", heading: "F1 · High — A", decision: { kind: "remediate", instruction: "Исправить." } },
            { findingId: "F2", heading: "F2 · High — B", decision: { kind: "remediate", instruction: "Исправить." } },
          ],
        };
      },
      async run(request) {
        await request.onFindingResolved();
        return {
          changeId,
          findingId: request.session.findingId,
          commit: hashes.c,
          remainingFindingIds: ["F1", "F2"],
          outcome: "blocked",
          reason: "Нужно выбрать формат миграции данных.",
        };
      },
    },
  });

  const decisions = stepContext(initialState({ initialPlannedPhases: [1] }));
  const recorded = await step.run(decisions.context);
  assert.equal(recorded.kind, "continue");
  assert.equal(recorded.next, "resolve-review-findings");
  assert.deepEqual(recorded.state, { pendingFindingDecisionSession: null });
  assert.equal(recorded.summary, "Записаны решения по findings review (устранить: F1, F2)");
  assert.deepEqual(decideRequests[0].taskScope, { kind: "initial-planning", plannedPhases: [1] });
  assert.deepEqual(
    decisions.checkpoints.map(({ pendingFindingDecisionSession }) => pendingFindingDecisionSession),
    [decisionSession, null],
  );

  planned = findingPlan("F1")();
  planned = await planned;
  const blocked = await step.run(stepContext(initialState({ initialPlannedPhases: [1] })).context);
  assert.equal(blocked.kind, "continue");
  assert.equal(blocked.next, "resolve-review-findings");
  assert.deepEqual(blocked.state, { pendingFindingResolutionSession: null });
  assert.equal(
    blocked.summary,
    "Finding F1 возвращена к решению пользователя: Нужно выбрать формат миграции данных.",
  );
});
