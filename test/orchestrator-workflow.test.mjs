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
import { OrchestratorController } from "../server/orchestrator-controller.ts";
import { OrchestratorLedger } from "../server/orchestrator-ledger.ts";
import { createOpenSpecWorkflow } from "../server/workflow/steps/index.ts";

const execFileAsync = promisify(execFile);
const changeId = "selected-change";
const changeBranch = `change/${changeId}`;
const planningBranch = `planning/${changeId}`;

async function temporaryHome(context, prefix = "openspec-workflow-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function settleWorkflow() {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

function requiredAgentProfiles() {
  return REQUIRED_AGENT_PROFILE_NAMES.map((name) => ({
    id: `profile-${name.toLowerCase().replaceAll(" ", "-")}`,
    name,
    provider: "codex",
    model: "gpt-5.5",
    modeId: "default",
    thinkingOptionId: "medium",
  }));
}

function mergedPlanningSession() {
  return {
    changeId,
    changeBranch,
    planningBranch,
    planningPullRequestNumber: 43,
    mergedPlanningHead: "d".repeat(40),
    repositoryHost: "github.com",
    repositoryNameWithOwner: "example/project",
    repositoryUrl: "https://github.com/example/project",
  };
}

function workflowHarness(options = {}) {
  const calls = [];
  let branchRead = 0;
  let mergeInspection = 0;
  const rootPullRequest = {
    number: 41,
    url: "https://github.com/example/project/pull/41",
  };
  const planningPullRequest = {
    number: 43,
    url: "https://github.com/example/project/pull/43",
    title: "Первичное ревью OpenSpec change",
  };

  const workflow = createOpenSpecWorkflow({
    workspaceDirectory: "/workspace/project",
    readAgentProfiles:
      options.readAgentProfiles ?? (async () => requiredAgentProfiles()),
    gitBranch: async () => {
      branchRead += 1;
      return {
        kind: "non-main",
        name: branchRead === 1 ? changeBranch : planningBranch,
      };
    },
    gitWorktree: options.gitWorktree ?? (async () => ({ kind: "clean" })),
    miseToolchain: options.miseToolchain ?? (async () => ({ kind: "available" })),
    changeInitialization: {
      async prepare(_workspace, selectedId, rootBranch) {
        calls.push(["initialize.prepare", selectedId, rootBranch]);
        return {
          changeId: selectedId,
          changeBranch: rootBranch,
          baselineCommit: "a".repeat(40),
          changeExisted: options.changeExisted ?? true,
          openSpecRoot: "/workspace/project",
          existingRootPullRequest: null,
        };
      },
      async initialize(_workspace, session) {
        calls.push(["initialize.initialize", session.changeBranch]);
        return {
          change: { id: session.changeId },
          changeBranch: session.changeBranch,
          pullRequest: rootPullRequest,
        };
      },
    },
    planningBranch: {
      async prepare(_workspace, selectedId, rootBranch) {
        calls.push(["planning.prepare", selectedId, rootBranch]);
        return {
          changeId: selectedId,
          changeBranch: rootBranch,
          planningBranch,
          baselineCommit: "a".repeat(40),
        };
      },
      async activate(_workspace, session) {
        calls.push(["planning.activate", session.planningBranch]);
        return session.planningBranch;
      },
    },
    verifyChange: async (_workspace, selectedId) => {
      calls.push(["change.verify", selectedId]);
      return { id: selectedId };
    },
    changeArtifacts: {
      async inspect() {
        calls.push(["artifacts.inspect"]);
        return { kind: "complete", schemaName: "spec-driven" };
      },
      async prepare() {
        throw new Error("Завершённому change не нужен следующий артефакт");
      },
      async create() {
        throw new Error("Завершённому change не нужен агент артефакта");
      },
      async verifyApply() {
        calls.push(["artifacts.verifyApply"]);
      },
    },
    changePublication: {
      async publish(request) {
        calls.push([
          "publication.publish",
          request.changeBranch,
          request.activeBranch,
        ]);
        request.onAgentCreated("agent-publication");
        return {
          number: rootPullRequest.number,
          url: rootPullRequest.url,
          title: "Опубликовать change",
        };
      },
    },
    changeReview: {
      async plan(_workspace, selectedId, rootBranch, activeBranch) {
        calls.push(["review.plan", rootBranch, activeBranch]);
        return {
          changeId: selectedId,
          parentBranch: rootBranch,
          reviewBranch: activeBranch,
          parentBaselineCommit: "a".repeat(40),
          baselineCommit: "c".repeat(40),
          repositoryHost: "github.com",
          repositoryNameWithOwner: "example/project",
          repositoryUrl: "https://github.com/example/project",
          parentPullRequestNumber: rootPullRequest.number,
        };
      },
      async run(request) {
        calls.push(["review.run", request.session.reviewBranch]);
        request.onAgentCreated("agent-review");
        return {
          changeId,
          reviewPath: `openspec/changes/${changeId}/review.md`,
          branch: planningBranch,
          pullRequest: planningPullRequest,
        };
      },
    },
    changeFindingResolution: {
      async plan(_workspace, selectedId, branch) {
        calls.push(["findings.plan", branch]);
        return {
          kind: "no-findings",
          reviewPath: `openspec/changes/${selectedId}/review.md`,
        };
      },
      async run() {
        throw new Error("Findings отсутствуют");
      },
    },
    implementationFindingResolution: {
      async plan(_workspace, selectedId, branch) {
        calls.push(["implementation-findings.plan", branch]);
        return {
          kind: "no-findings",
          reviewPath: `openspec/changes/${selectedId}/implementation-review.md`,
        };
      },
      async run() {
        throw new Error("Implementation findings отсутствуют");
      },
    },
    planningMerge: {
      async inspect(_workspace, selectedId, rootBranch, activeBranch) {
        mergeInspection += 1;
        calls.push(["merge.inspect", rootBranch, activeBranch]);
        if (options.mergeOpenOnce && mergeInspection === 1) {
          return { kind: "open", pullRequest: planningPullRequest };
        }
        return { kind: "merged", session: mergedPlanningSession() };
      },
      async complete(_workspace, session) {
        calls.push(["merge.complete", session.changeBranch]);
        return session.changeBranch;
      },
    },
    changeTaskExecution: {
      async plan(_workspace, selectedId, branch) {
        calls.push(["tasks.plan", selectedId, branch]);
        return { kind: "complete", schemaName: "spec-driven" };
      },
      async run() {
        throw new Error("Все задачи уже выполнены");
      },
    },
  });

  return { workflow, calls };
}

async function createEngine(context, harness) {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-1");
  const engine = new OpenSpecOrchestratorEngine(ledger);
  engine.initialize("workspace-1", {
    workspaceDisplay: { projectName: null, workspaceName: null },
    refreshWorkspaceDisplay: async () => ({
      projectName: null,
      workspaceName: null,
    }),
    workflow: harness.workflow,
  });
  context.after(async () => {
    await engine.dispose();
    await ledger.close();
  });
  return { engine, ledger };
}

test("определяет реальную Git-ветку и состояние рабочего дерева", async (context) => {
  const workspace = await temporaryHome(context, "openspec-git-");
  await execFileAsync("git", ["init", "-b", changeBranch], { cwd: workspace });
  assert.deepEqual(await readGitBranch(workspace), {
    kind: "non-main",
    name: changeBranch,
  });
  assert.deepEqual(await readGitWorktreeStatus(workspace), { kind: "clean" });
  await writeFile(join(workspace, "untracked.txt"), "изменение\n");
  assert.deepEqual(await readGitWorktreeStatus(workspace), { kind: "dirty" });
});

test("Git probe различает main, non-main, detached HEAD и небезопасный вывод", async () => {
  assert.deepEqual(
    await readGitBranch("/workspace", { command: async () => "main\n" }),
    { kind: "main", name: "main" },
  );
  assert.deepEqual(
    await readGitBranch("/workspace", {
      command: async () => `${changeBranch}\n`,
    }),
    { kind: "non-main", name: changeBranch },
  );
  assert.deepEqual(
    await readGitBranch("/workspace", { command: async () => "\n" }),
    { kind: "detached" },
  );
  await assert.rejects(
    readGitBranch("/workspace", {
      command: async () => "change/unsafe\u0001branch\n",
    }),
    /недопустимое имя ветки/,
  );
});

test("полный workflow получает change из root-ветки и запускает задачи после merge", async (context) => {
  const harness = workflowHarness();
  const { engine, ledger } = await createEngine(context, harness);
  engine.command("workspace-1", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-1");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(snapshot.change?.id, changeId);
  assert.deepEqual(harness.calls, [
    ["initialize.prepare", changeId, changeBranch],
    ["initialize.initialize", changeBranch],
    ["planning.prepare", changeId, changeBranch],
    ["planning.activate", planningBranch],
    ["change.verify", changeId],
    ["artifacts.inspect"],
    ["artifacts.verifyApply"],
    ["change.verify", changeId],
    ["artifacts.inspect"],
    ["artifacts.verifyApply"],
    ["publication.publish", changeBranch, planningBranch],
    ["review.plan", changeBranch, planningBranch],
    ["review.run", planningBranch],
    ["findings.plan", planningBranch],
    ["implementation-findings.plan", planningBranch],
    ["merge.inspect", changeBranch, planningBranch],
    ["merge.complete", changeBranch],
    ["change.verify", changeId],
    ["tasks.plan", changeId, changeBranch],
  ]);
  assert.ok(
    snapshot.history.some(({ text }) =>
      text === `Planning PR слит; workflow продолжен из ${changeBranch}`
    ),
  );
  assert.deepEqual(
    snapshot.history
      .flatMap(({ links }) => links)
      .map(({ agentId }) => agentId),
    ["agent-publication", "agent-review"],
  );
});

test("открытый planning PR останавливает workflow и Retry продолжает после merge", async (context) => {
  const harness = workflowHarness({ mergeOpenOnce: true });
  const { engine, ledger } = await createEngine(context, harness);
  engine.command("workspace-1", "start");
  await settleWorkflow();

  let snapshot = ledger.get("workspace-1");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.equal(snapshot.lifecycle.availableCommand, "retry");
  assert.match(snapshot.history.at(-1).text, /Planning PR #43 ожидает merge/);
  const checkpoint = ledger.getWorkflowCheckpoint("workspace-1");
  assert.equal(checkpoint?.version, 3);
  assert.equal(checkpoint?.nextStepId, "await-planning-merge");
  assert.equal(checkpoint?.state.changeBranch, changeBranch);
  assert.equal(checkpoint?.state.activeBranch, planningBranch);

  engine.command("workspace-1", "retry");
  await settleWorkflow();
  snapshot = ledger.get("workspace-1");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(
    harness.calls.filter(([name]) => name === "publication.publish").length,
    1,
  );
  assert.deepEqual(harness.calls.at(-1), ["tasks.plan", changeId, changeBranch]);
});

test("dirty worktree блокирует эффекты и Retry повторяет проверку", async (context) => {
  let worktreeReads = 0;
  const harness = workflowHarness({
    gitWorktree: async () => {
      worktreeReads += 1;
      return { kind: worktreeReads === 1 ? "dirty" : "clean" };
    },
  });
  const { engine, ledger } = await createEngine(context, harness);
  engine.command("workspace-1", "start");
  await settleWorkflow();
  assert.equal(ledger.get("workspace-1").lifecycle.status, "failed");
  assert.equal(harness.calls.length, 0);

  engine.command("workspace-1", "retry");
  await settleWorkflow();
  assert.equal(ledger.get("workspace-1").lifecycle.status, "completed");
  assert.equal(worktreeReads, 3);
});

test("невалидная root-ветка блокирует workflow до OpenSpec и GitHub", async (context) => {
  const harness = workflowHarness();
  const invalidWorkflow = createOpenSpecWorkflow({
    ...workflowDependenciesForBlockedBranch(),
    gitBranch: async () => ({ kind: "non-main", name: planningBranch }),
  });
  const invalidHarness = { workflow: invalidWorkflow };
  const { engine, ledger } = await createEngine(context, invalidHarness);
  engine.command("workspace-1", "start");
  await settleWorkflow();
  const snapshot = ledger.get("workspace-1");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.match(snapshot.history.at(-1).text, /change\/<change-id>/);
  assert.equal(harness.calls.length, 0);
});

test("checkpoint v3 восстанавливает точный шаг и пару root/active веток", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-recovery");
  let executions = 0;
  const workflow = {
    startStepId: "save-branches",
    steps: [
      {
        id: "save-branches",
        label: "Сохраняю ветки",
        async run() {
          return {
            kind: "continue",
            next: "recover-here",
            state: {
              changeBranch,
              activeBranch: planningBranch,
              change: { id: changeId },
            },
          };
        },
      },
      {
        id: "recover-here",
        label: "Восстанавливаю шаг",
        async run({ state }) {
          executions += 1;
          assert.equal(state.changeBranch, changeBranch);
          assert.equal(state.activeBranch, planningBranch);
          return executions === 1
            ? { kind: "halt", summary: "Ожидаю retry", message: "Повторите" }
            : { kind: "complete", summary: "Восстановлено" };
        },
      },
    ],
  };
  const contextValue = {
    workspaceDisplay: { projectName: null, workspaceName: null },
    refreshWorkspaceDisplay: async () => ({ projectName: null, workspaceName: null }),
    workflow,
  };
  let engine = new OpenSpecOrchestratorEngine(ledger);
  engine.initialize("workspace-recovery", contextValue);
  engine.command("workspace-recovery", "start");
  await settleWorkflow();
  assert.equal(
    ledger.getWorkflowCheckpoint("workspace-recovery")?.nextStepId,
    "recover-here",
  );
  await engine.dispose();

  engine = new OpenSpecOrchestratorEngine(ledger);
  engine.initialize("workspace-recovery", contextValue);
  engine.command("workspace-recovery", "retry");
  await settleWorkflow();
  assert.equal(ledger.get("workspace-recovery").lifecycle.status, "completed");
  await engine.dispose();
  await ledger.close();
});

test("clear отменяет активный шаг и удаляет checkpoint", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-clear");
  let aborted = false;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const engine = new OpenSpecOrchestratorEngine(ledger);
  engine.initialize("workspace-clear", {
    workspaceDisplay: { projectName: null, workspaceName: null },
    refreshWorkspaceDisplay: async () => ({ projectName: null, workspaceName: null }),
    workflow: {
      startStepId: "wait",
      steps: [{
        id: "wait",
        label: "Ожидаю",
        run: ({ signal }) => new Promise((_resolve, reject) => {
          markStarted();
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("Операция отменена", "AbortError"));
          }, { once: true });
        }),
      }],
    },
  });
  engine.command("workspace-clear", "start");
  await started;
  engine.command("workspace-clear", "clear");
  await settleWorkflow();
  assert.equal(aborted, true);
  assert.equal(ledger.getWorkflowCheckpoint("workspace-clear"), null);
  assert.deepEqual(ledger.get("workspace-clear").history, []);
  await engine.dispose();
  await ledger.close();
});

test("контроллер не создаёт ledger для workspace без директории", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  const controller = new OrchestratorController({
    ledger,
    createEngine: () => ({
      initialize() {},
      command() {},
      async dispose() {},
    }),
  });
  const paseo = {
    workspaces: {
      ref() {
        return { directory: null, async refresh() { return null; } };
      },
    },
  };
  await assert.rejects(
    controller.get("missing-workspace", paseo),
    /не имеет директории/,
  );
  assert.equal(ledger.has("missing-workspace"), false);
  await controller.close();
});

function workflowDependenciesForBlockedBranch() {
  return {
    workspaceDirectory: "/workspace/project",
    readAgentProfiles: async () => requiredAgentProfiles(),
    gitBranch: async () => ({ kind: "non-main", name: changeBranch }),
    gitWorktree: async () => ({ kind: "clean" }),
    miseToolchain: async () => ({ kind: "available" }),
    changeInitialization: {
      async prepare() { throw new Error("Не должен вызываться"); },
      async initialize() { throw new Error("Не должен вызываться"); },
    },
    planningBranch: {
      async prepare() { throw new Error("Не должен вызываться"); },
      async activate() { throw new Error("Не должен вызываться"); },
    },
    verifyChange: async () => { throw new Error("Не должен вызываться"); },
    changeArtifacts: { inspect() {}, prepare() {}, create() {}, verifyApply() {} },
    changePublication: { publish() {} },
    changeReview: { plan() {}, run() {} },
    changeFindingResolution: { plan() {}, run() {} },
    implementationFindingResolution: { plan() {}, run() {} },
    planningMerge: { inspect() {}, complete() {} },
    changeTaskExecution: { plan() {}, run() {} },
  };
}
