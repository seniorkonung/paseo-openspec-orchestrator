import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { REQUIRED_AGENT_PROFILE_NAMES } from "../server/agent-profiles.ts";
import { readGitBranch } from "../server/git-branch.ts";
import { readGitWorktreeStatus } from "../server/git-worktree.ts";
import { OpenSpecOrchestratorEngine } from "../server/openspec-orchestrator-engine.ts";
import { OrchestratorLedger } from "../server/orchestrator-ledger.ts";
import { createOpenSpecWorkflow } from "../server/workflow/steps/index.ts";
import { workflowCheckpointSchema } from "../server/workflow/types.ts";

const execFileAsync = promisify(execFile);
const changeId = "selected-change";
const changeBranch = `change/${changeId}`;
const planningBranch = `planning/${changeId}`;
const implementationBranch = `implementation/${changeId}`;
const hashes = Object.fromEntries("abcdefgh".split("").map((key) => [key, key.repeat(40)]));
const repository = {
  host: "github.com",
  nameWithOwner: "example/project",
  url: "https://github.com/example/project",
};

async function temporaryHome(context, prefix = "openspec-workflow-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function settleWorkflow() {
  await new Promise((resolve) => setTimeout(resolve, 200));
}

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

function workflowHarness({ feedbackOnce = false, mergeOpenOnce = false, worktree } = {}) {
  const calls = [];
  let branchReads = 0;
  let planningInspections = 0;
  let taskPlans = 0;
  let feedbackInspections = 0;
  const feedbackItem = {
    source: "comment",
    nodeId: "IC_kwDOExample",
    updatedAt: "2026-09-19T10:00:00Z",
    body: "Проверьте обработку ошибки",
    fingerprint: "9".repeat(64),
  };
  const implementationPullRequest = {
    number: 51,
    url: "https://github.com/example/project/pull/51",
    title: `Реализация OpenSpec change «${changeId}»`,
  };
  const workflow = createOpenSpecWorkflow({
    workspaceDirectory: "/workspace/project",
    readAgentProfiles: async () => profiles(),
    gitBranch: async () => ({
      kind: "non-main",
      name: ++branchReads === 1 ? changeBranch : planningBranch,
    }),
    gitWorktree: worktree ?? (async () => ({ kind: "clean" })),
    miseToolchain: async () => ({ kind: "available" }),
    implementationRunVerification: {
      async assertCurrent(_workspace, run) {
        calls.push("implementation.verify");
        return run.batch.kind === "reviewed"
          ? run.batch.reviewCommit
          : run.batch.kind === "collecting"
            ? run.batch.headCommit
            : run.batch.baseCommit;
      },
    },
    changeInitialization: {
      async prepare() {
        calls.push("initialize.prepare");
        return {
          changeId,
          changeBranch,
          baselineCommit: hashes.a,
          changeExisted: true,
          openSpecRoot: "/workspace/project",
          existingRootPullRequest: null,
        };
      },
      async initialize(_workspace, session) {
        calls.push("initialize.initialize");
        return {
          change: { id: session.changeId },
          changeBranch,
          pullRequest: { number: 41, url: "https://github.com/example/project/pull/41" },
        };
      },
    },
    planningBranch: {
      async prepare() {
        calls.push("planning.prepare");
        return { changeId, changeBranch, planningBranch, baselineCommit: hashes.a };
      },
      async activate() {
        calls.push("planning.activate");
        return planningBranch;
      },
    },
    verifyChange: async () => {
      calls.push("change.verify");
      return { id: changeId };
    },
    changeArtifacts: {
      async inspect() { return { kind: "complete", schemaName: "spec-driven" }; },
      async prepare() { throw new Error("не требуется"); },
      async create() { throw new Error("не требуется"); },
      async verifyApply() {},
    },
    changePublication: {
      async publish(request) {
        calls.push("publication.publish");
        request.onAgentCreated("publication-agent");
        return { number: 41, url: "https://github.com/example/project/pull/41", title: "Change" };
      },
    },
    changeReview: {
      async plan() {
        return {
          changeId,
          parentBranch: changeBranch,
          reviewBranch: planningBranch,
          parentBaselineCommit: hashes.a,
          baselineCommit: hashes.b,
          repositoryHost: repository.host,
          repositoryNameWithOwner: repository.nameWithOwner,
          repositoryUrl: repository.url,
          parentPullRequestNumber: 41,
        };
      },
      async run(request) {
        request.onAgentCreated("planning-review-agent");
        return {
          changeId,
          reviewPath: `openspec/changes/${changeId}/review.md`,
          branch: planningBranch,
          pullRequest: { number: 43, url: "https://github.com/example/project/pull/43", title: "Review" },
        };
      },
    },
    changeFindingResolution: {
      async plan(_workspace, _change, branch) {
        calls.push(`review-findings:${branch}`);
        return {
          kind: "no-findings",
          reviewPath: `openspec/changes/${changeId}/review.md`,
          headCommit: branch === planningBranch ? hashes.c : hashes.f,
        };
      },
      async run() { throw new Error("findings отсутствуют"); },
    },
    planningMerge: {
      async inspect() {
        planningInspections += 1;
        if (mergeOpenOnce && planningInspections === 1) {
          return { kind: "open", pullRequest: { number: 43, url: "https://github.com/example/project/pull/43", title: "Review" } };
        }
        return {
          kind: "merged",
          session: {
            changeId,
            changeBranch,
            planningBranch,
            planningPullRequestNumber: 43,
            mergedPlanningHead: hashes.c,
            repositoryHost: repository.host,
            repositoryNameWithOwner: repository.nameWithOwner,
            repositoryUrl: repository.url,
          },
        };
      },
      async complete() { calls.push("planning.merge"); return changeBranch; },
    },
    implementationBranch: {
      async prepare() {
        calls.push("implementation.prepare");
        return { changeId, changeBranch, implementationBranch, rootBaselineCommit: hashes.d, repository };
      },
      async activate() {
        calls.push("implementation.activate");
        return {
          changeId,
          changeBranch,
          implementationBranch,
          rootBaselineCommit: hashes.d,
          repository,
          publication: { kind: "unpublished" },
          batch: { kind: "empty", baseCommit: hashes.d },
          lastDeliveryHead: null,
          processedFeedbackFingerprints: [],
        };
      },
    },
    changeTaskExecution: {
      async plan() {
        taskPlans += 1;
        calls.push("tasks.plan");
        if (taskPlans > 1) return { kind: "complete", schemaName: "spec-driven" };
        return {
          kind: "next-task",
          session: {
            changeId,
            schemaName: "spec-driven",
            taskId: "task-a",
            taskNumber: "1.1",
            taskDescription: "1.1 Реализовать поведение",
            changeBranch,
            implementationBranch,
            rootBaselineCommit: hashes.d,
            baselineCommit: hashes.d,
            tasksBeforeDigest: "1".repeat(64),
            tasksAfterDigest: "2".repeat(64),
            progressTotal: 1,
            progressComplete: 0,
            repositoryHost: repository.host,
            repositoryNameWithOwner: repository.nameWithOwner,
            repositoryUrl: repository.url,
          },
        };
      },
      async run(request) {
        request.onAgentCreated("task-agent");
        const result = {
          changeId,
          taskId: "task-a",
          taskNumber: "1.1",
          branch: implementationBranch,
          commit: hashes.e,
          remainingTasks: 0,
        };
        await request.onTaskCompleted(result);
        return result;
      },
    },
    implementationReview: {
      async plan(_workspace, run) {
        return {
          changeId,
          changeBranch,
          implementationBranch,
          rootBaselineCommit: hashes.d,
          baseCommit: run.batch.baseCommit,
          reviewedHead: run.batch.headCommit,
          tasks: run.batch.tasks,
          repository,
        };
      },
      async run(request) {
        request.onAgentCreated("implementation-review-agent");
        const result = {
          changeId,
          branch: implementationBranch,
          baseCommit: hashes.d,
          reviewedHead: hashes.e,
          reviewCommit: hashes.f,
          pullRequest: implementationPullRequest,
        };
        await request.onReviewCompleted(result);
        return result;
      },
    },
    implementationFindingResolution: {
      async plan() {
        calls.push("implementation-findings");
        return {
          kind: "no-findings",
          reviewPath: `openspec/changes/${changeId}/implementation-review.md`,
          headCommit: hashes.f,
        };
      },
      async run() { throw new Error("findings отсутствуют"); },
    },
    implementationPullRequest: {
      async inspectFeedback() {
        calls.push("feedback.inspect");
        feedbackInspections += 1;
        return feedbackOnce && feedbackInspections === 1
          ? { kind: "feedback", items: [feedbackItem] }
          : { kind: "clean" };
      },
      async markReady() { calls.push("pr.ready"); return { kind: "clean" }; },
      async inspectReadyGate() {
        calls.push("merge.gate");
        return {
          kind: "merged",
          session: {
            changeId,
            changeBranch,
            implementationBranch,
            rootBaselineCommit: hashes.d,
            finalImplementationHead: hashes.f,
            pullRequestNumber: 51,
          },
        };
      },
      async completeMerge() { calls.push("implementation.merge"); return hashes.g; },
    },
    prFeedbackReview: {
      async plan(_workspace, run, items) {
        calls.push("feedback.plan");
        return {
          changeId,
          changeBranch,
          implementationBranch,
          rootBaselineCommit: hashes.d,
          rangeHead: hashes.e,
          baselineCommit: run.batch.baseCommit,
          reportBlob: "8".repeat(40),
          repository,
          items,
        };
      },
      async run(request) {
        calls.push("feedback.run");
        request.onAgentCreated("feedback-agent");
        const result = {
          changeId,
          branch: implementationBranch,
          mode: "no-report-change",
          head: hashes.f,
          processedFingerprints: [feedbackItem.fingerprint],
        };
        await request.onFeedbackReviewed(result);
        return result;
      },
    },
  });
  return { workflow, calls };
}

async function engineHarness(context, workflow) {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace");
  const engine = new OpenSpecOrchestratorEngine(ledger);
  engine.initialize("workspace", {
    workspaceDisplay: { projectName: null, workspaceName: null },
    refreshWorkspaceDisplay: async () => ({ projectName: null, workspaceName: null }),
    workflow,
  });
  context.after(async () => { await engine.dispose(); await ledger.close(); });
  return { engine, ledger };
}

test("определяет реальную Git-ветку и состояние рабочего дерева", async (context) => {
  const workspace = await temporaryHome(context, "openspec-git-");
  await execFileAsync("git", ["init", "-b", changeBranch], { cwd: workspace });
  assert.deepEqual(await readGitBranch(workspace), { kind: "non-main", name: changeBranch });
  assert.deepEqual(await readGitWorktreeStatus(workspace), { kind: "clean" });
  await writeFile(join(workspace, "dirty.txt"), "изменение\n");
  assert.deepEqual(await readGitWorktreeStatus(workspace), { kind: "dirty" });
});

test("workflow выполняет задачи, review и merge в одной implementation-ветке", async (context) => {
  const harness = workflowHarness();
  const { engine, ledger } = await engineHarness(context, harness.workflow);
  engine.command("workspace", "start");
  await settleWorkflow();
  const snapshot = ledger.get("workspace");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.ok(harness.calls.includes("implementation.prepare"));
  assert.equal(harness.calls.filter((call) => call === "tasks.plan").length, 3);
  assert.deepEqual(
    snapshot.history.flatMap(({ links }) => links).map(({ agentId }) => agentId),
    ["publication-agent", "planning-review-agent", "task-agent", "implementation-review-agent"],
  );
  assert.equal(ledger.getWorkflowCheckpoint("workspace"), null);
});

test("PR feedback проходит отдельный audit и возвращается в task-цикл", async (context) => {
  const harness = workflowHarness({ feedbackOnce: true });
  const { engine, ledger } = await engineHarness(context, harness.workflow);
  engine.command("workspace", "start");
  await settleWorkflow();
  const snapshot = ledger.get("workspace");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(harness.calls.filter((call) => call === "feedback.run").length, 1);
  assert.ok(harness.calls.indexOf("feedback.run") < harness.calls.lastIndexOf("tasks.plan"));
  assert.ok(
    snapshot.history.flatMap(({ links }) => links).some(({ agentId }) =>
      agentId === "feedback-agent"
    ),
  );
});

test("открытый planning PR сохраняет checkpoint v4 и Retry продолжает цикл", async (context) => {
  const harness = workflowHarness({ mergeOpenOnce: true });
  const { engine, ledger } = await engineHarness(context, harness.workflow);
  engine.command("workspace", "start");
  await settleWorkflow();
  let snapshot = ledger.get("workspace");
  assert.equal(snapshot.lifecycle.status, "failed");
  const checkpoint = ledger.getWorkflowCheckpoint("workspace");
  assert.equal(checkpoint.version, 4);
  assert.equal(checkpoint.nextStepId, "await-planning-merge");
  engine.command("workspace", "retry");
  await settleWorkflow();
  snapshot = ledger.get("workspace");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(harness.calls.filter((call) => call === "publication.publish").length, 1);
});

test("грязное дерево блокирует эффекты до Retry", async (context) => {
  let reads = 0;
  const harness = workflowHarness({
    worktree: async () => ({ kind: ++reads === 1 ? "dirty" : "clean" }),
  });
  const { engine, ledger } = await engineHarness(context, harness.workflow);
  engine.command("workspace", "start");
  await settleWorkflow();
  assert.equal(ledger.get("workspace").lifecycle.status, "failed");
  assert.equal(harness.calls.length, 0);
  engine.command("workspace", "retry");
  await settleWorkflow();
  assert.equal(ledger.get("workspace").lifecycle.status, "completed");
});

test("checkpoint v3 несовместим с v4", () => {
  assert.throws(() => workflowCheckpointSchema.parse({
    version: 3,
    nextStepId: "execute-change-tasks",
    state: {
      changeBranch,
      activeBranch: implementationBranch,
      change: { id: changeId },
    },
  }));
});
