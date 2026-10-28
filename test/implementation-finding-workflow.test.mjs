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
    phaseNumber: Number(number.split(".")[0]),
    fingerprint: phaseTaskFingerprint(id, number, description),
  };
}

function snapshot(tasks, phases = [1]) {
  return {
    phases: phases.map((number) => ({ number })),
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
  const runRequests = [];
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
        runRequests.push(request);
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
  if (mode === "completed") {
    assert.deepEqual(runRequests[0].taskScope, {
      kind: "implementation",
      phaseNumber: 1,
      baseline: initialProgress,
    });
  }
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

async function completeFindingWith(currentSnapshot) {
  const baseline = classifyPhaseWork(snapshot([task("1.1", false)], [1, 2]), null).progress;
  const checkpoints = [];
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
        return { kind: "finding-required", session: { findingId: "F1" } };
      },
      async run(request) {
        await request.onFindingResolved();
        return {
          findingId: "F1",
          commit: hashes.c,
          remainingFindingIds: [],
          pullRequest: { number: 41, url: "https://github.com/example/project/pull/41" },
        };
      },
    },
    implementationRunVerification: {
      async assertCurrent() {
        return hashes.c;
      },
    },
    phaseWork: {
      async inspect(_workspace, _changeId, previous) {
        return classifyPhaseWork(currentSnapshot, previous);
      },
    },
  });
  const result = await step.run({
    signal: new AbortController().signal,
    state: {
      ...createInitialWorkflowState(),
      change: { id: changeId },
      changeBranch,
      activeBranch: implementationBranch,
      phaseProgress: baseline,
      implementationRun,
    },
    updateActionLinks() {},
    async checkpointState(state) {
      checkpoints.push(state);
    },
    async notify() {
      return true;
    },
  });
  return { result, checkpoints };
}

test("implementation finding не наполняет задачами фазу, которую планирует оркестратор", async () => {
  const { result, checkpoints } = await completeFindingWith(
    snapshot([task("1.1", true), task("2.1", false)], [1, 2]),
  );

  assert.equal(result.kind, "halt");
  assert.match(
    result.summary,
    /Во время implementation run Phase 1 .*Задачи 2\.1 нарушают это правило: фазы без задач планирует оркестратор/u,
  );
  assert.equal(
    checkpoints.some(({ phaseProgress }) => phaseProgress.tasks.length > 1),
    false,
  );
});

test("implementation finding выносит remediation в новую фазу сразу после текущей", async () => {
  const { result } = await completeFindingWith(
    snapshot([task("1.1", true), task("3.1", false)], [1, 3, 2]),
  );

  assert.equal(result.kind, "continue");
  assert.equal(result.next, "execute-change-tasks");
  assert.deepEqual(result.state.phaseProgress.phases.map(({ number }) => number), [1, 3, 2]);
  assert.deepEqual(
    result.state.phaseProgress.tasks.map(({ number, done }) => ({ number, done })),
    [
      { number: "1.1", done: true },
      { number: "3.1", done: false },
    ],
  );
});

const highProfiles = async () => [{
  id: "profile-high",
  name: "High",
  provider: "codex",
  model: "gpt-6-astra",
  modeId: "default",
  thinkingOptionId: "high",
}];

const decisionSession = {
  changeId,
  branch: implementationBranch,
  findingIds: ["F1", "F2"],
  baselineCommit: hashes.c,
};

function stepWith(findingResolution, phaseInspections = []) {
  return createResolveImplementationReviewFindingsStep({
    workspaceDirectory: "/repo",
    readAgentProfiles: highProfiles,
    findingResolution,
    implementationRunVerification: { async assertCurrent() { return hashes.c; } },
    phaseWork: {
      async inspect(_workspace, _changeId, previous) {
        phaseInspections.push(previous);
        return classifyPhaseWork(snapshot([task("1.1", true)]), previous);
      },
    },
  });
}

function stepContext(state, checkpoints, links = []) {
  return {
    signal: new AbortController().signal,
    state: {
      ...createInitialWorkflowState(),
      change: { id: changeId },
      changeBranch,
      activeBranch: implementationBranch,
      phaseProgress: initialProgress,
      implementationRun,
      ...state,
    },
    updateActionLinks(value) { links.push(value); },
    async checkpointState(value) { checkpoints.push(value); },
    async notify() { return true; },
  };
}

test("findings без решений запускают одну сессию решений и возвращаются к исполнению", async () => {
  const checkpoints = [];
  const links = [];
  const decideRequests = [];
  const step = stepWith({
    async plan() {
      return { kind: "decisions-required", session: decisionSession };
    },
    async run() {
      throw new Error("исполнение не должно начинаться до записи решений");
    },
    async decide(request) {
      decideRequests.push(request);
      request.onAgentCreated("agent-decisions");
      await request.onDecisionsRecorded();
      return {
        changeId,
        commit: hashes.c,
        decisions: [
          { findingId: "F1", heading: "F1 · High — Проблема", decision: { kind: "remediate", instruction: "Исправить." } },
          {
            findingId: "F2",
            heading: "F2 · Low — Риск",
            decision: { kind: "accept-risk", rationale: "Дёшево.", scope: "Только тест.", reopenWhen: "Никогда." },
          },
        ],
      };
    },
  });

  const result = await step.run(stepContext({}, checkpoints, links));

  assert.equal(result.kind, "continue");
  assert.equal(result.next, "resolve-implementation-review-findings");
  assert.deepEqual(result.state, { pendingImplementationFindingDecisionSession: null });
  assert.equal(
    result.summary,
    "Записаны решения по findings implementation review (устранить: F1; принять риск: F2)",
  );
  assert.equal(decideRequests.length, 1);
  assert.deepEqual(decideRequests[0].session, decisionSession);
  assert.equal(decideRequests[0].taskScope.kind, "implementation");
  assert.deepEqual(
    checkpoints.map(({ pendingImplementationFindingDecisionSession }) => pendingImplementationFindingDecisionSession),
    [decisionSession, null],
  );
  assert.deepEqual(links, [[{ kind: "agent", agentId: "agent-decisions", label: "Решения по implementation findings" }]]);
});

test("сохранённая сессия решений продолжается без нового планирования", async () => {
  let plans = 0;
  let decided = 0;
  const step = stepWith({
    async plan() {
      plans += 1;
      throw new Error("план не нужен");
    },
    async run() {
      throw new Error("исполнение не нужно");
    },
    async decide(request) {
      decided += 1;
      assert.deepEqual(request.session, decisionSession);
      return { changeId, commit: hashes.c, decisions: [] };
    },
  });
  const result = await step.run(
    stepContext({ pendingImplementationFindingDecisionSession: decisionSession }, []),
  );
  assert.equal(result.kind, "continue");
  assert.equal(result.next, "resolve-implementation-review-findings");
  assert.equal(plans, 0);
  assert.equal(decided, 1);
});

test("препятствие возвращает implementation finding к решению без завершения пакета", async () => {
  const phaseInspections = [];
  const step = stepWith({
    async plan() {
      return { kind: "finding-required", findingId: "F1", session: { findingId: "F1" } };
    },
    async run(request) {
      await request.onFindingResolved();
      return {
        changeId,
        findingId: "F1",
        commit: hashes.c,
        remainingFindingIds: ["F1"],
        outcome: "blocked",
        reason: "Решение требует изменить публичный контракт.",
      };
    },
    async decide() {
      throw new Error("решения не нужны");
    },
  }, phaseInspections);

  const result = await step.run(stepContext({}, []));

  assert.equal(result.kind, "continue");
  assert.equal(result.next, "resolve-implementation-review-findings");
  assert.deepEqual(result.state, { pendingImplementationFindingResolutionSession: null });
  assert.equal(
    result.summary,
    "Implementation finding F1 возвращена к решению пользователя: Решение требует изменить публичный контракт.",
  );
  assert.equal(phaseInspections.length, 0);
});

test("длинная причина препятствия укорачивается до лимита истории", async () => {
  const reason = `Нужно новое решение: ${"а".repeat(480)}`;
  const step = stepWith({
    async plan() {
      return { kind: "finding-required", findingId: "F1", session: { findingId: "F1" } };
    },
    async run(request) {
      await request.onFindingResolved();
      return {
        changeId,
        findingId: "F1",
        commit: hashes.c,
        remainingFindingIds: ["F1"],
        outcome: "blocked",
        reason,
      };
    },
    async decide() {
      throw new Error("решения не нужны");
    },
  });
  const result = await step.run(stepContext({}, []));
  assert.equal(result.kind, "continue");
  assert.equal(result.summary.length, 500);
  assert.match(result.summary, /^Implementation finding F1 возвращена к решению пользователя: Нужно новое решение/u);
  assert.match(result.summary, /…$/u);
});
