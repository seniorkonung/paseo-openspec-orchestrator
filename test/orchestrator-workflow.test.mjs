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
import { createInitialWorkflowState, workflowCheckpointSchema } from "../server/workflow/types.ts";
import { phaseTaskFingerprint } from "../server/phase-work.ts";

const execFileAsync = promisify(execFile);
const changeId = "selected-change";
const changeBranch = `change/${changeId}`;
const planningBranch = changeBranch;
const implementationBranch = changeBranch;
const hashes = Object.fromEntries([
  ..."abcdef".split("").map((key) => [key, key.repeat(40)]),
  ["g", "1".repeat(40)], ["h", "2".repeat(40)], ["i", "3".repeat(40)],
]);
const repository = {
  host: "github.com",
  nameWithOwner: "example/project",
  url: "https://github.com/example/project",
};
const rootPullRequestIdentity = {
  number: 41,
  url: "https://github.com/example/project/pull/41",
  repositoryHost: repository.host,
  repositoryNameWithOwner: repository.nameWithOwner,
  repositoryUrl: repository.url,
  changeBranch,
};
const phaseProgress = {
  phases: [{ number: 1, fingerprint: "1".repeat(64) }],
  tasks: [{
    id: "task-a",
    number: "1.1",
    description: "1.1 Реализовать поведение",
    done: false,
    fingerprint: phaseTaskFingerprint("task-a", "1.1", "1.1 Реализовать поведение"),
  }],
  nextImplementationRun: 1,
};

async function temporaryHome(context, prefix = "openspec-workflow-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function settleWorkflow(ledger) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { status } = ledger.get("workspace").lifecycle;
    if (status !== "starting" && status !== "running" && status !== "pausing") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

function workflowHarness({ feedbackOnce = false, reviewFindings = 0, twoPhases = false, worktree } = {}) {
  const calls = [];
  let branchReads = 0;
  let planningInspections = 0;
  let taskPlans = 0;
  const taskPlansByPhase = new Map();
  let feedbackInspections = 0;
  let phaseInspections = 0;
  let resolvedReviewFindings = 0;
  let rootReady = false;
  let rootMerged = false;
  let archivePublished = false;
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
      name: changeBranch,
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
      async prepare(_workspace, selectedChangeId, selectedChangeBranch) {
        assert.equal(selectedChangeId, changeId);
        assert.equal(selectedChangeBranch, changeBranch);
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
      async prepare(_workspace, selectedChangeId, selectedChangeBranch) {
        assert.equal(selectedChangeId, changeId);
        assert.equal(selectedChangeBranch, changeBranch);
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
          phaseNumber: null,
          parentBaselineCommit: hashes.b,
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
          pullRequest: { number: 41, url: "https://github.com/example/project/pull/41", title: "Review" },
        };
      },
    },
    changeFindingResolution: {
      async plan(_workspace, _change, branch) {
        calls.push(`review-findings:${branch}`);
        if (resolvedReviewFindings < reviewFindings) {
          return { kind: "finding-required", findingId: `F${resolvedReviewFindings + 1}`,
            session: { changeId, branch, findingId: `F${resolvedReviewFindings + 1}`,
              baselineCommit: hashes.c } };
        }
        return {
          kind: "no-findings",
          reviewPath: `openspec/changes/${changeId}/review.md`,
          headCommit: branch === planningBranch ? hashes.c : hashes.f,
        };
      },
      async run(request) {
        calls.push("review-finding.resolve");
        request.onAgentCreated("review-finding-agent");
        resolvedReviewFindings += 1;
        await request.onFindingResolved();
        return { findingId: request.session.findingId, commit: hashes.c,
          remainingFindingIds: resolvedReviewFindings < reviewFindings ? [`F${resolvedReviewFindings + 1}`] : [],
          pullRequest: { number: 41, url: rootPullRequestIdentity.url } };
      },
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
      async prepare(_workspace, _changeId, _branch, phaseNumber, runNumber) {
        calls.push("implementation.prepare");
        return { changeId, changeBranch, implementationBranch, phaseNumber, runNumber,
          rootBaselineCommit: phaseNumber === 1 ? hashes.d : hashes.g, repository };
      },
      async activate(_workspace, session) {
        calls.push("implementation.activate");
        return {
          changeId,
          changeBranch,
          implementationBranch,
          phaseNumber: session.phaseNumber,
          runNumber: session.runNumber,
          rootBaselineCommit: session.rootBaselineCommit,
          repository,
          publication: { kind: "unreviewed" },
          batch: { kind: "empty", baseCommit: session.rootBaselineCommit },
        };
      },
    },
    changeTaskExecution: {
      async plan(_workspace, run) {
        taskPlans += 1;
        calls.push("tasks.plan");
        const count = (taskPlansByPhase.get(run.phaseNumber) ?? 0) + 1;
        taskPlansByPhase.set(run.phaseNumber, count);
        if (count > 1) return { kind: "complete", schemaName: "spec-driven" };
        const taskId = run.phaseNumber === 1 ? "task-a" : "task-b";
        const taskNumber = run.phaseNumber === 1 ? "1.1" : "2.1";
        return {
          kind: "next-task",
          session: {
            changeId,
            schemaName: "spec-driven",
            taskId,
            taskNumber,
            taskDescription: `${taskNumber} Реализовать поведение`,
            changeBranch,
            implementationBranch,
            phaseNumber: run.phaseNumber,
            rootBaselineCommit: run.rootBaselineCommit,
            baselineCommit: run.rootBaselineCommit,
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
        const phaseNumber = request.session.phaseNumber;
        const result = {
          changeId,
          taskId: request.session.taskId,
          taskNumber: request.session.taskNumber,
          branch: implementationBranch,
          commit: phaseNumber === 1 ? hashes.e : hashes.h,
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
          rootBaselineCommit: run.rootBaselineCommit,
          baseCommit: run.batch.baseCommit,
          reviewedHead: run.batch.headCommit,
          tasks: run.batch.tasks,
          repository,
        };
      },
      async run(request) {
        assert.equal(request.profile.name, "High");
        request.onAgentCreated("implementation-review-agent");
        const result = {
          changeId,
          branch: implementationBranch,
          baseCommit: request.session.baseCommit,
          reviewedHead: request.session.reviewedHead,
          reviewCommit: request.run.phaseNumber === 1 ? hashes.f : hashes.i,
          pullRequest: { ...implementationPullRequest, number: 41, url: rootPullRequestIdentity.url },
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
        assert.equal(request.profile.name, "High");
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
    phaseWork: {
      async inspect() {
        phaseInspections += 1;
        const secondTask = { id: "task-b", number: "2.1", description: "2.1 Реализовать поведение",
          done: phaseInspections > 3, fingerprint: phaseTaskFingerprint("task-b", "2.1", "2.1 Реализовать поведение") };
        const progress = {
          ...phaseProgress,
          phases: twoPhases ? [...phaseProgress.phases, { number: 2, fingerprint: "2".repeat(64) }] : phaseProgress.phases,
          tasks: [
            { ...phaseProgress.tasks[0], done: phaseInspections > 1 },
            ...(twoPhases ? [secondTask] : []),
          ],
          nextImplementationRun: phaseInspections > 3 ? 3 : 2,
        };
        return phaseInspections === 1
          ? {
              kind: "implementation-required",
              phaseNumber: 1,
              runNumber: 1,
              progress,
              snapshot: {},
            }
          : twoPhases && phaseInspections <= 3
            ? { kind: "implementation-required", phaseNumber: 2, runNumber: 2, progress, snapshot: {} }
          : { kind: "change-complete", progress, snapshot: {} };
      },
    },
    phaseTaskPlanning: {
      async prepare() { throw new Error("phase planning не требуется"); },
      async run() { throw new Error("phase planning не требуется"); },
    },
    rootPullRequest: {
      async synchronize() { return archivePublished ? hashes.h : hashes.f; },
      async inspect() {
        return rootMerged
          ? { kind: "merged", head: archivePublished ? hashes.h : hashes.f, identity: rootPullRequestIdentity }
          : { kind: "open", isDraft: !rootReady, head: archivePublished ? hashes.h : hashes.f, identity: rootPullRequestIdentity };
      },
      async makeDraft(_workspace, inspection) { rootReady = false; return { ...inspection, isDraft: true }; },
      async makeReady(_workspace, inspection) { rootReady = true; return { ...inspection, isDraft: false }; },
    },
    changeArchive: {
      async plan() {
        calls.push("archive.plan");
        return { changeId, branch: changeBranch, baselineCommit: hashes.f,
          sourcePath: `openspec/changes/${changeId}`,
          archivePath: `openspec/changes/archive/2026-09-25-${changeId}`,
          rootPullRequest: rootPullRequestIdentity };
      },
      async run(request) {
        assert.equal(request.profile.name, "High");
        calls.push("archive.run");
        request.onAgentCreated("archive-agent");
        archivePublished = true;
        return { session: request.session, commit: hashes.h };
      },
      async verifyArchived() { calls.push("archive.verify"); },
    },
  });
  return { workflow, calls, mergeRoot: () => { rootMerged = true; }, get rootReady() { return rootReady; } };
}

async function engineHarness(context, workflow) {
  const paseoHome = await mkdtemp(join(tmpdir(), "openspec-workflow-"));
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace");
  const engine = new OpenSpecOrchestratorEngine(ledger);
  engine.initialize("workspace", {
    workspaceDisplay: { projectName: null, workspaceName: null },
    refreshWorkspaceDisplay: async () => ({ projectName: null, workspaceName: null }),
    workflow,
  });
  context.after(async () => { await engine.dispose(); await ledger.close(); await rm(paseoHome, { recursive: true, force: true }); });
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

test("workflow выполняет задачи и ревью в одном PR, затем ждёт ручной merge", async (context) => {
  const harness = workflowHarness();
  const { engine, ledger } = await engineHarness(context, harness.workflow);
  engine.command("workspace", "start");
  await settleWorkflow(ledger);
  assert.equal(ledger.get("workspace").lifecycle.status, "failed");
  assert.equal(harness.rootReady, true);
  assert.equal(ledger.getWorkflowCheckpoint("workspace").version, 6);
  assert.equal(ledger.getWorkflowCheckpoint("workspace").nextStepId, "await-root-merge");
  assert.equal(ledger.getWorkflowCheckpoint("workspace").state.archivedChange.commit, hashes.h);
  assert.ok(harness.calls.includes("implementation.prepare"));
  assert.equal(harness.calls.filter((call) => call === "tasks.plan").length, 3);
  assert.equal(harness.calls.includes("planning.merge"), false);
  assert.equal(harness.calls.includes("implementation.merge"), false);
  assert.equal(harness.calls.includes("feedback.inspect"), false);
  assert.deepEqual(
    ledger.get("workspace").history.flatMap(({ links }) => links)
      .filter((link) => link.kind === "agent").map(({ agentId }) => agentId),
    ["publication-agent", "planning-review-agent", "task-agent", "implementation-review-agent", "archive-agent"],
  );
  harness.mergeRoot();
  engine.command("workspace", "retry");
  await settleWorkflow(ledger);
  assert.equal(ledger.get("workspace").lifecycle.status, "completed");
  assert.equal(ledger.getWorkflowCheckpoint("workspace"), null);
});

test("комментарии корневого PR не запускают обработку feedback", async (context) => {
  const harness = workflowHarness({ feedbackOnce: true });
  const { engine, ledger } = await engineHarness(context, harness.workflow);
  engine.command("workspace", "start");
  await settleWorkflow(ledger);
  assert.equal(ledger.get("workspace").lifecycle.status, "failed");
  assert.equal(harness.calls.includes("feedback.inspect"), false);
  assert.equal(harness.calls.includes("feedback.run"), false);
  assert.equal(harness.calls.includes("feedback.plan"), false);
});

test("две фазы проходят через один Draft PR и завершаются одним ручным merge", async (context) => {
  const harness = workflowHarness({ twoPhases: true });
  const { engine, ledger } = await engineHarness(context, harness.workflow);
  engine.command("workspace", "start");
  await settleWorkflow(ledger);
  assert.equal(ledger.get("workspace").lifecycle.status, "failed");
  assert.equal(harness.rootReady, true);
  assert.equal(harness.calls.filter((call) => call === "implementation.prepare").length, 2);
  assert.equal(ledger.get("workspace").history.flatMap(({ links }) => links)
    .filter((link) => link.kind === "agent" && link.agentId === "implementation-review-agent").length, 2);
  assert.equal(harness.calls.filter((call) => call === "publication.publish").length, 1);
  assert.equal(harness.calls.includes("planning.merge"), false);
  assert.equal(harness.calls.includes("implementation.merge"), false);
  harness.mergeRoot();
  engine.command("workspace", "retry");
  await settleWorkflow(ledger);
  assert.equal(ledger.get("workspace").lifecycle.status, "completed");
});

test("несколько findings устраняются последовательно в корневом PR", async (context) => {
  const harness = workflowHarness({ reviewFindings: 2 });
  const { engine, ledger } = await engineHarness(context, harness.workflow);
  engine.command("workspace", "start");
  await settleWorkflow(ledger);
  assert.equal(ledger.get("workspace").lifecycle.status, "failed");
  assert.equal(harness.rootReady, true);
  assert.equal(harness.calls.filter((call) => call === "review-finding.resolve").length, 2);
  assert.equal(harness.calls.includes("planning.merge"), false);
  assert.equal(harness.calls.includes("implementation.merge"), false);
});

test("незавершённый change не допускает преждевременный merge корневого PR", async (context) => {
  const harness = workflowHarness();
  harness.mergeRoot();
  const { engine, ledger } = await engineHarness(context, harness.workflow);
  engine.command("workspace", "start");
  await settleWorkflow(ledger);
  assert.equal(ledger.get("workspace").lifecycle.status, "failed");
  assert.match(ledger.get("workspace").history.at(-1).text, /слит|merge|PR/iu);
});

test("грязное дерево блокирует эффекты до Retry", async (context) => {
  let reads = 0;
  const harness = workflowHarness({
    worktree: async () => ({ kind: ++reads === 1 ? "dirty" : "clean" }),
  });
  const { engine, ledger } = await engineHarness(context, harness.workflow);
  engine.command("workspace", "start");
  await settleWorkflow(ledger);
  const blockedSnapshot = ledger.get("workspace");
  assert.equal(blockedSnapshot.lifecycle.status, "failed");
  assert.deepEqual(blockedSnapshot.change, { id: changeId });
  assert.equal(harness.calls.length, 0);
  engine.command("workspace", "retry");
  await settleWorkflow(ledger);
  assert.equal(harness.rootReady, true);
  harness.mergeRoot();
  engine.command("workspace", "retry");
  await settleWorkflow(ledger);
  assert.equal(ledger.get("workspace").lifecycle.status, "completed");
});

test("checkpoint v5 несовместим с v6", () => {
  assert.throws(() => workflowCheckpointSchema.parse({
    version: 5,
    nextStepId: "execute-change-tasks",
    state: {
      changeBranch,
      activeBranch: implementationBranch,
      change: { id: changeId },
    },
  }));
});

test("checkpoint v6 без полей архивации сохраняет совместимость", () => {
  const state = createInitialWorkflowState();
  delete state.pendingArchiveSession;
  delete state.archivedChange;
  const checkpoint = workflowCheckpointSchema.parse({ version: 6, nextStepId: "inspect-phase-work", state });
  assert.equal(checkpoint.state.pendingArchiveSession, null);
  assert.equal(checkpoint.state.archivedChange, null);
});
