import assert from "node:assert/strict";
import test from "node:test";
import { REQUIRED_AGENT_PROFILE_NAMES } from "../server/agent-profiles.ts";
import { createAssessTaskProfilesStep } from "../server/workflow/steps/assess-task-profiles.ts";
import { createExecuteChangeTasksStep } from "../server/workflow/steps/execute-change-tasks.ts";
import { createInitialWorkflowState } from "../server/workflow/types.ts";
import { ORCHESTRATOR_LIMITS } from "../shared/orchestrator.ts";

const changeId = "selected-change";
const changeBranch = `change/${changeId}`;
const base = "a".repeat(40);
const head = "b".repeat(40);
const repository = { host: "github.com", nameWithOwner: "example/project", url: "https://github.com/example/project" };

function run(batch = { kind: "empty", baseCommit: base }) {
  return {
    changeId, changeBranch, implementationBranch: changeBranch, phaseNumber: 2, runNumber: 1,
    rootBaselineCommit: base, repository, publication: { kind: "unreviewed" }, batch,
  };
}

function plannedTask() {
  return {
    changeId, schemaName: "spec-driven", taskId: "task-1", taskNumber: "2.1",
    taskDescription: "2.1 Первая задача", phaseNumber: 2, changeBranch, implementationBranch: changeBranch,
    rootBaselineCommit: base, baselineCommit: base, tasksBeforeDigest: "1".repeat(64),
    tasksAfterDigest: "2".repeat(64), progressTotal: 2, progressComplete: 0,
    repositoryHost: repository.host, repositoryNameWithOwner: repository.nameWithOwner, repositoryUrl: repository.url,
  };
}

function context(state, checkpoints = []) {
  return {
    signal: new AbortController().signal,
    pauseSignal: new AbortController().signal,
    state: {
      ...createInitialWorkflowState(),
      changeBranch, activeBranch: changeBranch, change: { id: changeId }, implementationRun: run(), ...state,
    },
    updateActionLinks() {},
    async checkpointState(next) { checkpoints.push(next); },
    async notify() { return true; },
  };
}

const agentProfiles = async () => REQUIRED_AGENT_PROFILE_NAMES.map((name) => ({
  id: name, name, provider: "codex", model: `model-${name.toLowerCase()}`, modeId: "default", thinkingOptionId: "high",
}));

test("переход к оценке профилей большой фазы укладывается в предел текста действия", async () => {
  const tasks = Array.from({ length: 100 }, (_, index) => ({
    number: `2.${index + 1}`,
    description: `2.${index + 1} Задача с достаточно длинным описанием`,
  }));
  const step = createExecuteChangeTasksStep({
    workspaceDirectory: "/repo",
    readAgentProfiles: agentProfiles,
    taskExecution: {
      async plan() { return { kind: "next-task", session: plannedTask() }; },
      async run() { assert.fail("Задача не запускается до оценки"); },
    },
    taskProfiles: {
      async inspect() {
        return {
          kind: "assessment-required",
          session: { changeId, branch: changeBranch, phaseNumber: 2, baselineCommit: base, tasks },
        };
      },
    },
  });
  const checkpoints = [];
  const result = await step.run(context({}, checkpoints));
  assert.equal(result.kind, "continue");
  assert.equal(result.next, "assess-task-profiles");
  assert.ok(result.summary.length <= ORCHESTRATOR_LIMITS.actionText);
  assert.match(result.summary, /2\.12 и ещё 88$/u);
  assert.deepEqual(checkpoints, [], "task-сессия не сохраняется до оценки");
});

test("длинная причина эскалации и ошибка файла профилей не превышают пределов ledger", async () => {
  const reason = `Причина ${"очень ".repeat(300)}длинная`;
  const step = createExecuteChangeTasksStep({
    workspaceDirectory: "/repo",
    readAgentProfiles: agentProfiles,
    taskExecution: {
      async plan() { assert.fail("Сессия уже сохранена"); },
      async run(request) {
        assert.equal(request.profile.name, "Medium");
        return {
          kind: "escalated",
          escalation: { changeId, taskId: "task-1", taskNumber: "2.1", reason, commit: head },
        };
      },
    },
    taskProfiles: { async inspect() { assert.fail("Профиль уже назначен"); } },
  });
  const pending = { ...plannedTask(), profile: "Medium", escalationReason: null };
  const escalated = await step.run(context({ pendingTaskExecutionSession: pending }));
  assert.equal(escalated.kind, "continue");
  assert.equal(escalated.next, "execute-change-tasks");
  assert.equal(escalated.state.pendingTaskExecutionSession, null);
  assert.ok(escalated.summary.startsWith("Задача 2.1 передана с Medium на High: Причина"));
  assert.ok(escalated.summary.length <= ORCHESTRATOR_LIMITS.actionText);

  const { TaskProfilesError } = await import("../server/task-profile-model.ts");
  const broken = createExecuteChangeTasksStep({
    workspaceDirectory: "/repo",
    readAgentProfiles: agentProfiles,
    taskExecution: { async plan() { return { kind: "next-task", session: plannedTask() }; }, async run() {} },
    taskProfiles: { async inspect() { throw new TaskProfilesError(`task-profiles.md: ${"x".repeat(2_000)}`); } },
  });
  const halted = await broken.run(context({}));
  assert.equal(halted.kind, "halt");
  assert.ok(halted.summary.startsWith("task-profiles.md: "));
  assert.ok(halted.summary.length <= ORCHESTRATOR_LIMITS.actionText);
  assert.ok(halted.message.length <= ORCHESTRATOR_LIMITS.message);
});

test("оценка профилей не запускается для проверенного пакета и передаёт его findings", async () => {
  const step = createAssessTaskProfilesStep({
    workspaceDirectory: "/repo",
    readAgentProfiles: agentProfiles,
    taskProfiles: {
      async inspect() { assert.fail("Проверенный пакет не оценивается"); },
      async run() { assert.fail("Агент не запускается"); },
    },
  });
  const reviewed = run({
    kind: "reviewed", baseCommit: base, headCommit: head, reviewCommit: "c".repeat(40),
    tasks: [{ taskId: "task-1", taskNumber: "2.1", commit: head }],
  });
  const result = await step.run(context({
    implementationRun: { ...reviewed, publication: { kind: "reviewed", number: 41, url: `${repository.url}/pull/41`, title: "Change" } },
  }));
  assert.equal(result.kind, "continue");
  assert.equal(result.next, "resolve-implementation-review-findings");
});

test("оценку профилей выполняет High, а коммит оценки продолжает открытый пакет", async () => {
  const collecting = run({
    kind: "collecting", baseCommit: base, headCommit: head, tasks: [{ taskId: "task-1", taskNumber: "2.1", commit: head }],
  });
  const commit = "d".repeat(40);
  const session = {
    changeId, branch: changeBranch, phaseNumber: 2, baselineCommit: head,
    tasks: [{ number: "2.2", description: "2.2 Вторая задача" }],
  };
  const records = [{
    taskNumber: "2.2", heading: "2.2 Вторая задача",
    assignment: { kind: "assessed", profile: "Medium", rationale: "Понятная правка" },
  }];
  const checkpoints = [];
  const step = createAssessTaskProfilesStep({
    workspaceDirectory: "/repo",
    readAgentProfiles: agentProfiles,
    taskProfiles: {
      async inspect() { return { kind: "assessment-required", session }; },
      async run(request) {
        assert.equal(request.profile.name, "High");
        const recorded = { changeId, phaseNumber: 2, commit, records };
        await request.onProfilesRecorded(recorded);
        return recorded;
      },
    },
  });
  const result = await step.run(context({ implementationRun: collecting }, checkpoints));
  assert.equal(result.kind, "continue");
  assert.equal(result.next, "execute-change-tasks");
  assert.equal(result.summary, "Профили задач Phase 2 назначены: Medium: 2.2");
  assert.equal(result.state.implementationRun.batch.headCommit, commit);
  assert.deepEqual(checkpoints.map((state) => state.pendingTaskProfileAssessmentSession), [session, null]);
  assert.equal(checkpoints[1].implementationRun.batch.headCommit, commit);
});
