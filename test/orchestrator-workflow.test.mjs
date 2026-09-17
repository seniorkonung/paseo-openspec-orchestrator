import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { REQUIRED_AGENT_PROFILE_NAMES } from "../server/agent-profiles.ts";
import { OpenSpecOrchestratorEngine } from "../server/openspec-orchestrator-engine.ts";
import { readGitBranch } from "../server/git-branch.ts";
import { readGitWorktreeStatus } from "../server/git-worktree.ts";
import { REQUIRED_MISE_TOOLS } from "../server/mise-toolchain.ts";
import { OrchestratorController } from "../server/orchestrator-controller.ts";
import { OrchestratorLedger } from "../server/orchestrator-ledger.ts";
import { createOrchestratorReporter } from "../server/orchestrator-reporter.ts";

const execFileAsync = promisify(execFile);

async function temporaryHome(context, prefix = "openspec-workflow-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const nextEventLoop = () => new Promise((resolve) => setImmediate(resolve));

async function settleWorkflow() {
  // Workflow теперь дожидается атомарной записи checkpoint после каждого шага.
  // Пауза оставляет время завершить fsync без привязки к диску и не
  // конкурирует с удалением временного каталога в context.after.
  await new Promise((resolve) => setTimeout(resolve, 100));
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

function immediateChangeSelection(changeId = "selected-change") {
  return {
    async verify(_workspaceDirectory, selectedId) {
      return { id: selectedId };
    },
    async select({ profile, onAgentCreated, onChangeSelected }) {
      assert.equal(profile.name, "Low Sandbox");
      onAgentCreated("agent-change-selection");
      const change = { id: changeId };
      await onChangeSelected(change);
      return change;
    },
  };
}

function completedChangeArtifacts() {
  return {
    async inspect() {
      return { kind: "complete", schemaName: "spec-driven" };
    },
    async prepare() {
      throw new Error("Для завершённого change нельзя готовить артефакт");
    },
    async create() {
      throw new Error("Для завершённого change нельзя создавать артефакт");
    },
    async verifyApply() {},
  };
}

function completedChangePublication() {
  return {
    async publish(request) {
      request.onAgentCreated("agent-change-publication");
      return {
        number: 42,
        url: "https://github.com/example/project/pull/42",
        title: "Опубликовать выбранный change",
      };
    },
  };
}

function completedChangeReview() {
  return {
    async plan(_workspaceDirectory, changeId, branch) {
      return {
        kind: "review-required",
        session: {
          changeId,
          branch,
          baselineCommit: "c".repeat(40),
        },
      };
    },
    async run(request) {
      request.onAgentCreated("agent-change-review");
      const review = {
        changeId: request.changeId,
        reviewPath: `openspec/changes/${request.changeId}/review.md`,
      };
      await request.onReviewCompleted(review);
      return review;
    },
  };
}

function completedChangeFindingResolution() {
  return {
    async plan(_workspaceDirectory, changeId) {
      return {
        kind: "no-findings",
        reviewPath: `openspec/changes/${changeId}/review.md`,
      };
    },
    async run() {
      throw new Error("При отсутствии findings агент не должен запускаться");
    },
  };
}

function completedImplementationFindingResolution() {
  return {
    async plan(_workspaceDirectory, changeId) {
      return {
        kind: "no-findings",
        reviewPath: `openspec/changes/${changeId}/implementation-review.md`,
      };
    },
    async run() {
      throw new Error("При отсутствии implementation findings агент не должен запускаться");
    },
  };
}

function engineContext(
  workspaceDirectory = "/workspace/project",
  readAgentProfiles = async () => requiredAgentProfiles(),
  changeSelection = immediateChangeSelection(),
  miseToolchain = async () => ({ kind: "available" }),
  changeArtifacts = completedChangeArtifacts(),
  changePublication = completedChangePublication(),
  changeReview = completedChangeReview(),
  changeFindingResolution = completedChangeFindingResolution(),
  implementationFindingResolution = completedImplementationFindingResolution(),
) {
  const workspaceDisplay = { projectName: null, workspaceName: null };
  return {
    workspaceDirectory,
    workspaceDisplay,
    refreshWorkspaceDisplay: async () => workspaceDisplay,
    readAgentProfiles,
    miseToolchain,
    changeSelection,
    changeArtifacts,
    changePublication,
    changeReview,
    changeFindingResolution,
    implementationFindingResolution,
  };
}

test("определяет реальную Git-ветку в директории workspace", async (context) => {
  const workspaceDirectory = await temporaryHome(context, "openspec-git-");
  await execFileAsync("git", ["init"], { cwd: workspaceDirectory });
  await execFileAsync("git", ["checkout", "-b", "feature/branch-guard"], {
    cwd: workspaceDirectory,
  });

  assert.deepEqual(await readGitBranch(workspaceDirectory), {
    kind: "non-main",
    name: "feature/branch-guard",
  });
});

test("возвращает типизированное решение для main, non-main и detached HEAD", async () => {
  const command = async () => "main\n";
  assert.deepEqual(await readGitBranch("/workspace", { command }), {
    kind: "main",
    name: "main",
  });

  assert.deepEqual(
    await readGitBranch("/workspace", { command: async () => "feature/login\n" }),
    { kind: "non-main", name: "feature/login" },
  );
  assert.deepEqual(await readGitBranch("/workspace", { command: async () => "\n" }), {
    kind: "detached",
  });
  await assert.rejects(
    readGitBranch("/workspace", { command: async () => "feature/\u0001bad\n" }),
    /недопустимое имя ветки/,
  );
});

test("определяет чистое и изменённое рабочее дерево Git", async () => {
  assert.deepEqual(await readGitWorktreeStatus("/workspace", { command: async () => "" }), {
    kind: "clean",
  });
  assert.deepEqual(
    await readGitWorktreeStatus("/workspace", {
      command: async () => " M tracked.txt\n?? untracked.txt\n",
    }),
    { kind: "dirty" },
  );
});

test("проверяет реальное рабочее дерево с неотслеживаемым и изменённым файлом", async (context) => {
  const workspaceDirectory = await temporaryHome(context, "openspec-git-status-");
  await execFileAsync("git", ["init"], { cwd: workspaceDirectory });

  assert.deepEqual(await readGitWorktreeStatus(workspaceDirectory), { kind: "clean" });

  const filePath = join(workspaceDirectory, "tracked.txt");
  await writeFile(filePath, "initial\n");
  assert.deepEqual(await readGitWorktreeStatus(workspaceDirectory), { kind: "dirty" });

  await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspaceDirectory });
  await writeFile(filePath, "modified\n");
  assert.deepEqual(await readGitWorktreeStatus(workspaceDirectory), { kind: "dirty" });
});

test("на non-main ветке workflow завершает инициализацию", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-1");
  const directories = [];
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async (directory) => {
      directories.push(directory);
      return { kind: "non-main", name: "feature/orchestrator" };
    },
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize("workspace-1", engineContext());

  engine.command("workspace-1", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-1");
  assert.deepEqual(directories, ["/workspace/project", "/workspace/project"]);
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(snapshot.change?.id, "selected-change");
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Все обязательные профили агентов доступны", "succeeded"],
    ["Git-ветка: feature/orchestrator", "succeeded"],
    ["Рабочее дерево Git чистое", "succeeded"],
    ["Mise toolchain доступен", "succeeded"],
    ["OpenSpec change готов к apply: selected-change", "succeeded"],
    ["Pull request #42 опубликован: https://github.com/example/project/pull/42", "succeeded"],
    [
      "Review OpenSpec change опубликован: openspec/changes/selected-change/review.md",
      "succeeded",
    ],
    [
      "В review нет нерешённых findings: openspec/changes/selected-change/review.md",
      "succeeded",
    ],
    [
      "В implementation review нет нерешённых findings: openspec/changes/selected-change/implementation-review.md",
      "succeeded",
    ],
  ]);
  assert.deepEqual(snapshot.history.at(-5)?.links, [
    {
      kind: "agent",
      agentId: "agent-change-selection",
      label: "Выбор OpenSpec change",
    },
  ]);
  assert.deepEqual(snapshot.history.at(-4)?.links, [
    {
      kind: "agent",
      agentId: "agent-change-publication",
      label: "Публикация change selected-change",
    },
  ]);
  assert.deepEqual(snapshot.history.at(-3)?.links, [
    {
      kind: "agent",
      agentId: "agent-change-review",
      label: "Review change selected-change",
    },
  ]);
  assert.deepEqual(snapshot.history.at(-2)?.links, []);
  assert.deepEqual(snapshot.history.at(-1)?.links, []);
  await engine.dispose();
  await ledger.close();
});

test("незавершённый change создаёт по одному артефакту и повторяет шаг", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-artifact-loop");
  let profileReads = 0;
  let inspectCalls = 0;
  let prepareCalls = 0;
  let createCalls = 0;
  let verifyApplyCalls = 0;
  const sessions = [];
  const profiles = [];
  const changeArtifacts = {
    async inspect() {
      inspectCalls += 1;
      return createCalls >= 2
        ? { kind: "complete", schemaName: "custom-flow" }
        : {
            kind: "next-artifact",
            schemaName: "custom-flow",
            artifactId: `artifact-${createCalls + 1}`,
          };
    },
    async prepare() {
      prepareCalls += 1;
      return {
        artifactId: `artifact-${createCalls + 1}`,
        schemaName: "custom-flow",
        baselineCommit: String(createCalls + 1).repeat(40),
      };
    },
    async create(request) {
      sessions.push(request.session);
      profiles.push(request.profile.name);
      request.onAgentCreated(`agent-artifact-${createCalls + 1}`);
      createCalls += 1;
      const plan =
        createCalls === 2
          ? { kind: "complete", schemaName: "custom-flow" }
          : {
              kind: "next-artifact",
              schemaName: "custom-flow",
              artifactId: "artifact-2",
            };
      await request.onArtifactCompleted(plan);
      return plan;
    },
    async verifyApply() {
      verifyApplyCalls += 1;
    },
  };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({ kind: "non-main", name: "feature/artifact-loop" }),
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-artifact-loop",
    engineContext(
      "/workspace/project",
      async () => {
        profileReads += 1;
        return requiredAgentProfiles();
      },
      immediateChangeSelection(),
      async () => ({ kind: "available" }),
      changeArtifacts,
    ),
  );

  engine.command("workspace-artifact-loop", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-artifact-loop");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(profileReads, 6);
  assert.equal(inspectCalls, 4);
  assert.equal(prepareCalls, 2);
  assert.equal(createCalls, 2);
  assert.equal(verifyApplyCalls, 2);
  assert.deepEqual(profiles, ["Ultra Sandbox", "Ultra Sandbox"]);
  assert.deepEqual(
    sessions.map(({ artifactId }) => artifactId),
    ["artifact-1", "artifact-2"],
  );
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Все обязательные профили агентов доступны", "succeeded"],
    ["Git-ветка: feature/artifact-loop", "succeeded"],
    ["Рабочее дерево Git чистое", "succeeded"],
    ["Mise toolchain доступен", "succeeded"],
    ["Выбран OpenSpec change: selected-change", "succeeded"],
    ["Создан OpenSpec-артефакт: artifact-1", "succeeded"],
    ["OpenSpec change готов к apply: selected-change", "succeeded"],
    ["Pull request #42 опубликован: https://github.com/example/project/pull/42", "succeeded"],
    [
      "Review OpenSpec change опубликован: openspec/changes/selected-change/review.md",
      "succeeded",
    ],
    [
      "В review нет нерешённых findings: openspec/changes/selected-change/review.md",
      "succeeded",
    ],
    [
      "В implementation review нет нерешённых findings: openspec/changes/selected-change/implementation-review.md",
      "succeeded",
    ],
  ]);
  assert.deepEqual(snapshot.history.at(-6)?.links, [
    {
      kind: "agent",
      agentId: "agent-artifact-1",
      label: "Артефакт artifact-1",
    },
  ]);
  assert.deepEqual(snapshot.history.at(-5)?.links, [
    {
      kind: "agent",
      agentId: "agent-artifact-2",
      label: "Артефакт artifact-2",
    },
  ]);
  assert.deepEqual(snapshot.history.at(-4)?.links, [
    {
      kind: "agent",
      agentId: "agent-change-publication",
      label: "Публикация change selected-change",
    },
  ]);
  assert.deepEqual(snapshot.history.at(-3)?.links, [
    {
      kind: "agent",
      agentId: "agent-change-review",
      label: "Review change selected-change",
    },
  ]);
  assert.deepEqual(snapshot.history.at(-2)?.links, []);
  assert.deepEqual(snapshot.history.at(-1)?.links, []);
  await engine.dispose();
  await ledger.close();
});

test("изменения рабочего дерева блокируют workflow, а retry проверяет заново", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-dirty");
  let worktree = { kind: "dirty" };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({ kind: "non-main", name: "feature/clean-check" }),
    worktreeProbe: async () => worktree,
  });
  engine.initialize("workspace-dirty", engineContext());

  engine.command("workspace-dirty", "start");
  await settleWorkflow();
  let snapshot = ledger.get("workspace-dirty");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.equal(snapshot.lifecycle.availableCommand, "retry");
  assert.match(snapshot.lifecycle.message, /незакоммиченные или неотслеживаемые/);
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Все обязательные профили агентов доступны", "succeeded"],
    ["Git-ветка: feature/clean-check", "succeeded"],
    ["Рабочее дерево Git содержит изменения", "failed"],
  ]);

  worktree = { kind: "clean" };
  engine.command("workspace-dirty", "retry");
  await settleWorkflow();
  snapshot = ledger.get("workspace-dirty");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Все обязательные профили агентов доступны", "succeeded"],
    ["Git-ветка: feature/clean-check", "succeeded"],
    ["Рабочее дерево Git содержит изменения", "failed"],
    ["Рабочее дерево Git чистое", "succeeded"],
    ["Mise toolchain доступен", "succeeded"],
    ["OpenSpec change готов к apply: selected-change", "succeeded"],
    ["Pull request #42 опубликован: https://github.com/example/project/pull/42", "succeeded"],
    [
      "Review OpenSpec change опубликован: openspec/changes/selected-change/review.md",
      "succeeded",
    ],
    [
      "В review нет нерешённых findings: openspec/changes/selected-change/review.md",
      "succeeded",
    ],
    [
      "В implementation review нет нерешённых findings: openspec/changes/selected-change/implementation-review.md",
      "succeeded",
    ],
  ]);
  await engine.dispose();
  await ledger.close();
});

test("новые изменения рабочего дерева блокируют публикацию до запуска агента", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-dirty-publication");
  let worktreeReads = 0;
  let publishCalls = 0;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({ kind: "non-main", name: "feature/dirty-publication" }),
    worktreeProbe: async () => {
      worktreeReads += 1;
      return worktreeReads === 1 ? { kind: "clean" } : { kind: "dirty" };
    },
  });
  engine.initialize(
    "workspace-dirty-publication",
    engineContext(
      "/workspace/project",
      async () => requiredAgentProfiles(),
      immediateChangeSelection(),
      async () => ({ kind: "available" }),
      completedChangeArtifacts(),
      {
        async publish() {
          publishCalls += 1;
          throw new Error("Агент публикации не должен запускаться");
        },
      },
    ),
  );

  engine.command("workspace-dirty-publication", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-dirty-publication");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.match(snapshot.lifecycle.message, /незакоммиченные или неотслеживаемые/);
  assert.equal(worktreeReads, 2);
  assert.equal(publishCalls, 0);
  assert.equal(snapshot.history.at(-1)?.text, "Рабочее дерево Git содержит изменения");
  await engine.dispose();
  await ledger.close();
});

test("смена Git-ветки после planning блокирует публикацию", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-branch-drift");
  let branchReads = 0;
  let publishCalls = 0;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => {
      branchReads += 1;
      return {
        kind: "non-main",
        name: branchReads === 1 ? "feature/original" : "feature/other",
      };
    },
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-branch-drift",
    engineContext(
      "/workspace/project",
      async () => requiredAgentProfiles(),
      immediateChangeSelection(),
      async () => ({ kind: "available" }),
      completedChangeArtifacts(),
      {
        async publish() {
          publishCalls += 1;
          throw new Error("Агент публикации не должен запускаться");
        },
      },
    ),
  );

  engine.command("workspace-branch-drift", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-branch-drift");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.match(snapshot.lifecycle.message, /Вернитесь в ветку «feature\/original»/);
  assert.equal(branchReads, 2);
  assert.equal(publishCalls, 0);
  await engine.dispose();
  await ledger.close();
});

test("preflight mise toolchain блокирует выбор change и повторяется после исправления", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-toolchain");
  let decision = {
    kind: "tool-unavailable",
    reason: "not-configured",
    tool: REQUIRED_MISE_TOOLS[0],
  };
  let selectCalls = 0;
  const changeSelection = {
    verify: async (_workspace, changeId) => ({ id: changeId }),
    async select({ onAgentCreated, onChangeSelected }) {
      selectCalls += 1;
      onAgentCreated("agent-toolchain-selection");
      const change = { id: "selected-change" };
      await onChangeSelected(change);
      return change;
    },
  };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({ kind: "non-main", name: "feature/toolchain" }),
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-toolchain",
    engineContext(
      "/workspace/project",
      async () => requiredAgentProfiles(),
      changeSelection,
      async () => decision,
    ),
  );

  engine.command("workspace-toolchain", "start");
  await settleWorkflow();
  let snapshot = ledger.get("workspace-toolchain");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.match(snapshot.lifecycle.message, /npm:@fission-ai\/openspec/);
  assert.equal(selectCalls, 0);

  decision = { kind: "available" };
  engine.command("workspace-toolchain", "retry");
  await settleWorkflow();
  snapshot = ledger.get("workspace-toolchain");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(selectCalls, 1);
  assert.equal(snapshot.change?.id, "selected-change");
  await engine.dispose();
  await ledger.close();
});

test("отсутствующие профили блокируют Git-проверки, а retry читает их заново", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-profiles");
  let profiles = requiredAgentProfiles().filter(({ name }) => name !== "Orchestrator");
  let profileReads = 0;
  let branchReads = 0;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => {
      branchReads += 1;
      return { kind: "non-main", name: "feature/profile-check" };
    },
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-profiles",
    engineContext("/workspace/project", async () => {
      profileReads += 1;
      return profiles;
    }),
  );

  engine.command("workspace-profiles", "start");
  await settleWorkflow();
  let snapshot = ledger.get("workspace-profiles");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.match(snapshot.lifecycle.message, /Orchestrator/);
  assert.equal(branchReads, 0);
  assert.equal(profileReads, 1);

  profiles = requiredAgentProfiles();
  engine.command("workspace-profiles", "retry");
  await settleWorkflow();
  snapshot = ledger.get("workspace-profiles");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(profileReads, 5);
  assert.equal(branchReads, 2);
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Отсутствуют профили агентов: Orchestrator", "failed"],
    ["Все обязательные профили агентов доступны", "succeeded"],
    ["Git-ветка: feature/profile-check", "succeeded"],
    ["Рабочее дерево Git чистое", "succeeded"],
    ["Mise toolchain доступен", "succeeded"],
    ["OpenSpec change готов к apply: selected-change", "succeeded"],
    ["Pull request #42 опубликован: https://github.com/example/project/pull/42", "succeeded"],
    [
      "Review OpenSpec change опубликован: openspec/changes/selected-change/review.md",
      "succeeded",
    ],
    [
      "В review нет нерешённых findings: openspec/changes/selected-change/review.md",
      "succeeded",
    ],
    [
      "В implementation review нет нерешённых findings: openspec/changes/selected-change/implementation-review.md",
      "succeeded",
    ],
  ]);
  await engine.dispose();
  await ledger.close();
});

test("ошибка чтения профилей останавливает workflow с безопасным сообщением", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-profile-error");
  let branchReads = 0;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => {
      branchReads += 1;
      return { kind: "non-main", name: "feature/profile-error" };
    },
  });
  engine.initialize(
    "workspace-profile-error",
    engineContext("/workspace/project", async () => {
      throw new Error("секретная диагностическая информация");
    }),
  );

  engine.command("workspace-profile-error", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-profile-error");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.match(snapshot.lifecycle.message, /Не удалось получить профили агентов из Paseo/);
  assert.doesNotMatch(snapshot.lifecycle.message, /секретная/);
  assert.equal(branchReads, 0);
  await engine.dispose();
  await ledger.close();
});

test("неполный профиль останавливает workflow до Git и называет поле", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-incomplete-profile");
  let branchReads = 0;
  const profiles = requiredAgentProfiles();
  profiles.find(({ name }) => name === "Medium Sandbox").model = "   ";
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => {
      branchReads += 1;
      return { kind: "non-main", name: "feature/should-not-run" };
    },
  });
  engine.initialize(
    "workspace-incomplete-profile",
    engineContext("/workspace/project", async () => profiles),
  );

  engine.command("workspace-incomplete-profile", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-incomplete-profile");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.match(snapshot.lifecycle.message, /Medium Sandbox \(model\)/);
  assert.equal(branchReads, 0);
  await engine.dispose();
  await ledger.close();
});

test("перед запуском агента повторно проверяет изменившийся профиль", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-profile-changed");
  let profileReads = 0;
  let selectCalls = 0;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({ kind: "non-main", name: "feature/profile-changed" }),
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-profile-changed",
    engineContext(
      "/workspace/project",
      async () => {
        profileReads += 1;
        const profiles = requiredAgentProfiles();
        if (profileReads === 2) {
          profiles.find(({ name }) => name === "Low Sandbox").thinkingOptionId = " ";
        }
        return profiles;
      },
      {
        verify: async (_workspace, changeId) => ({ id: changeId }),
        async select() {
          selectCalls += 1;
          throw new Error("Агент не должен быть создан");
        },
      },
    ),
  );

  engine.command("workspace-profile-changed", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-profile-changed");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.match(snapshot.lifecycle.message, /Low Sandbox \(thinkingOptionId\)/);
  assert.equal(profileReads, 2);
  assert.equal(selectCalls, 0);
  await engine.dispose();
  await ledger.close();
});

test("перед публикацией повторно проверяет профиль Medium Sandbox", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-publication-profile-changed");
  let profileReads = 0;
  let publishCalls = 0;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({ kind: "non-main", name: "feature/publication-profile" }),
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-publication-profile-changed",
    engineContext(
      "/workspace/project",
      async () => {
        profileReads += 1;
        const profiles = requiredAgentProfiles();
        if (profileReads === 3) {
          profiles.find(({ name }) => name === "Medium Sandbox").model = " ";
        }
        return profiles;
      },
      immediateChangeSelection(),
      async () => ({ kind: "available" }),
      completedChangeArtifacts(),
      {
        async publish() {
          publishCalls += 1;
          throw new Error("Агент публикации не должен запускаться");
        },
      },
    ),
  );

  engine.command("workspace-publication-profile-changed", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-publication-profile-changed");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.match(snapshot.lifecycle.message, /Medium Sandbox \(model\)/);
  assert.equal(profileReads, 3);
  assert.equal(publishCalls, 0);
  await engine.dispose();
  await ledger.close();
});

test("workflow выполняет отдельные шаги и передаёт состояние дальше", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-steps");
  const seenStates = [];
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    steps: [
      {
        id: "first-step",
        label: "Первый шаг",
        run: async () => ({
          kind: "continue",
          next: "second-step",
          summary: "Первый шаг завершён",
          state: { branch: "feature/from-step" },
        }),
      },
      {
        id: "second-step",
        label: "Второй шаг",
        run: async ({ state }) => {
          seenStates.push({ ...state });
          return { kind: "complete", summary: "Второй шаг завершён" };
        },
      },
    ],
  });
  engine.initialize("workspace-steps", engineContext());

  engine.command("workspace-steps", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-steps");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.deepEqual(seenStates, [
    {
      branch: "feature/from-step",
      change: null,
      pendingArtifactSession: null,
      pendingReviewSession: null,
      pendingFindingResolutionSession: null,
      pendingImplementationFindingResolutionSession: null,
    },
  ]);
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Первый шаг завершён", "succeeded"],
    ["Второй шаг завершён", "succeeded"],
  ]);
  await engine.dispose();
  await ledger.close();
});

test("workflow следует явным переходам и может возвращаться к предыдущему шагу", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-graph");
  let hasIssues = true;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    steps: [
      {
        id: "execute-task",
        label: "Выполняю задачу",
        run: async () => ({
          kind: "continue",
          next: hasIssues ? "resolve-issues" : "review-result",
          summary: hasIssues ? "Обнаружены проблемы" : "Задача выполнена",
        }),
      },
      {
        id: "resolve-issues",
        label: "Разбираю проблемы",
        run: async () => {
          hasIssues = false;
          return {
            kind: "continue",
            next: "execute-task",
            summary: "Проблемы разобраны",
          };
        },
      },
      {
        id: "review-result",
        label: "Проверяю результат",
        run: async () => ({ kind: "complete", summary: "Review завершён" }),
      },
    ],
  });
  engine.initialize("workspace-graph", engineContext());

  engine.command("workspace-graph", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-graph");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Обнаружены проблемы", "succeeded"],
    ["Проблемы разобраны", "succeeded"],
    ["Задача выполнена", "succeeded"],
    ["Review завершён", "succeeded"],
  ]);
  await engine.dispose();
  await ledger.close();
});

test("после перезапуска workflow продолжает работу с сохранённого checkpoint", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-resume");

  let secondStarted;
  const secondStartedPromise = new Promise((resolve) => {
    secondStarted = resolve;
  });
  const steps = [
    {
      id: "first",
      label: "Первый шаг",
      async run() {
        return {
          kind: "continue",
          next: "second",
          state: { branch: "feature/resume" },
        };
      },
    },
    {
      id: "second",
      label: "Второй шаг",
      async run({ signal }) {
        secondStarted();
        await new Promise((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", resolve, { once: true });
        });
        return { kind: "complete" };
      },
    },
  ];
  const engine = new OpenSpecOrchestratorEngine(ledger, { steps });
  engine.initialize("workspace-resume", engineContext());
  engine.command("workspace-resume", "start");
  await secondStartedPromise;
  await ledger.flush();
  assert.deepEqual(ledger.getWorkflowCheckpoint("workspace-resume"), {
    version: 1,
    nextStepId: "second",
    state: {
      branch: "feature/resume",
      change: null,
      pendingArtifactSession: null,
      pendingReviewSession: null,
      pendingFindingResolutionSession: null,
      pendingImplementationFindingResolutionSession: null,
    },
  });

  await engine.dispose();
  await ledger.close();

  const restoredLedger = new OrchestratorLedger({ paseoHome });
  await restoredLedger.open("workspace-resume");
  const resumedContexts = [];
  const resumedEngine = new OpenSpecOrchestratorEngine(restoredLedger, {
    steps: [
      {
        id: "first",
        label: "Первый шаг",
        async run() {
          throw new Error("Первый шаг не должен быть повторён");
        },
      },
      {
        id: "second",
        label: "Второй шаг",
        async run(context) {
          resumedContexts.push(context);
          return { kind: "complete" };
        },
      },
    ],
  });
  resumedEngine.initialize("workspace-resume", engineContext());
  assert.equal(restoredLedger.get("workspace-resume").lifecycle.status, "idle");
  assert.equal(restoredLedger.get("workspace-resume").history.at(-1)?.outcome, "cancelled");

  resumedEngine.command("workspace-resume", "start");
  await settleWorkflow();
  assert.equal(resumedContexts.length, 1);
  assert.equal(resumedContexts[0].state.branch, "feature/resume");
  assert.equal(resumedContexts[0].state.change, null);
  assert.equal(restoredLedger.get("workspace-resume").lifecycle.status, "completed");
  assert.equal(restoredLedger.getWorkflowCheckpoint("workspace-resume"), null);
  await resumedEngine.dispose();
  await restoredLedger.close();
});

test("retry после перезапуска повторяет ошибочный шаг с durable checkpoint", async (context) => {
  const paseoHome = await temporaryHome(context);
  const workspaceId = "workspace-failed-retry";
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open(workspaceId);
  const firstEngine = new OpenSpecOrchestratorEngine(ledger, {
    steps: [
      {
        id: "first",
        label: "Первый шаг",
        async run() {
          return {
            kind: "continue",
            next: "second",
            state: { branch: "feature/failed-retry" },
          };
        },
      },
      {
        id: "second",
        label: "Второй шаг",
        async run() {
          return {
            kind: "halt",
            summary: "Второй шаг остановлен",
            message: "Исправьте причину и повторите шаг",
          };
        },
      },
    ],
  });
  firstEngine.initialize(workspaceId, engineContext());
  firstEngine.command(workspaceId, "start");
  await settleWorkflow();

  assert.equal(ledger.get(workspaceId).lifecycle.status, "failed");
  assert.equal(ledger.getWorkflowCheckpoint(workspaceId)?.nextStepId, "second");
  await firstEngine.dispose();
  await ledger.close();

  const restoredLedger = new OrchestratorLedger({ paseoHome });
  await restoredLedger.open(workspaceId);
  const receivedStates = [];
  const restoredEngine = new OpenSpecOrchestratorEngine(restoredLedger, {
    steps: [
      {
        id: "first",
        label: "Первый шаг",
        async run() {
          throw new Error("Первый шаг не должен быть повторён");
        },
      },
      {
        id: "second",
        label: "Второй шаг",
        async run({ state }) {
          receivedStates.push(state);
          return { kind: "complete", summary: "Второй шаг завершён" };
        },
      },
    ],
  });
  restoredEngine.initialize(workspaceId, engineContext());
  assert.equal(restoredLedger.get(workspaceId).lifecycle.status, "failed");

  restoredEngine.command(workspaceId, "retry");
  await settleWorkflow();

  assert.equal(receivedStates.length, 1);
  assert.equal(receivedStates[0].branch, "feature/failed-retry");
  assert.equal(restoredLedger.get(workspaceId).lifecycle.status, "completed");
  assert.deepEqual(
    restoredLedger.get(workspaceId).history.map(({ text, outcome }) => [text, outcome]),
    [
      ["Первый шаг", "succeeded"],
      ["Второй шаг остановлен", "failed"],
      ["Второй шаг завершён", "succeeded"],
    ],
  );
  await restoredEngine.dispose();
  await restoredLedger.close();
});

test("первый ошибочный шаг можно повторить после перезапуска", async (context) => {
  const paseoHome = await temporaryHome(context);
  const workspaceId = "workspace-first-step-retry";
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open(workspaceId);
  const firstEngine = new OpenSpecOrchestratorEngine(ledger, {
    steps: [
      {
        id: "first",
        label: "Первый шаг",
        async run() {
          return {
            kind: "halt",
            summary: "Первый шаг остановлен",
            message: "Повторите первый шаг",
          };
        },
      },
    ],
  });
  firstEngine.initialize(workspaceId, engineContext());
  firstEngine.command(workspaceId, "start");
  await settleWorkflow();

  assert.equal(ledger.getWorkflowCheckpoint(workspaceId)?.nextStepId, "first");
  await firstEngine.dispose();
  await ledger.close();

  const restoredLedger = new OrchestratorLedger({ paseoHome });
  await restoredLedger.open(workspaceId);
  let restoredRuns = 0;
  const restoredEngine = new OpenSpecOrchestratorEngine(restoredLedger, {
    steps: [
      {
        id: "first",
        label: "Первый шаг",
        async run() {
          restoredRuns += 1;
          return { kind: "complete", summary: "Первый шаг завершён" };
        },
      },
    ],
  });
  restoredEngine.initialize(workspaceId, engineContext());
  restoredEngine.command(workspaceId, "retry");
  await settleWorkflow();

  assert.equal(restoredRuns, 1);
  assert.equal(restoredLedger.get(workspaceId).lifecycle.status, "completed");
  await restoredEngine.dispose();
  await restoredLedger.close();
});

test("retry передаёт шагу последнее durable-состояние внутри этого шага", async (context) => {
  const paseoHome = await temporaryHome(context);
  const workspaceId = "workspace-inner-checkpoint-retry";
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open(workspaceId);
  const receivedSessions = [];
  const pendingSession = {
    artifactId: "risk-map",
    schemaName: "custom-flow",
    baselineCommit: "a".repeat(40),
  };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    steps: [
      {
        id: "prepare",
        label: "Подготавливаю состояние",
        async run() {
          return {
            kind: "continue",
            next: "unstable",
            state: { branch: "feature/inner-checkpoint" },
          };
        },
      },
      {
        id: "unstable",
        label: "Выполняю нестабильный шаг",
        async run({ checkpointState, state }) {
          receivedSessions.push(state.pendingArtifactSession);
          if (!state.pendingArtifactSession) {
            await checkpointState({ ...state, pendingArtifactSession: pendingSession });
            return {
              kind: "halt",
              summary: "Нестабильный шаг остановлен",
              message: "Повторите нестабильный шаг",
            };
          }
          return { kind: "complete", summary: "Нестабильный шаг завершён" };
        },
      },
    ],
  });
  engine.initialize(workspaceId, engineContext());
  engine.command(workspaceId, "start");
  await settleWorkflow();
  engine.command(workspaceId, "retry");
  await settleWorkflow();

  assert.deepEqual(receivedSessions, [null, pendingSession]);
  assert.deepEqual(
    ledger.get(workspaceId).history.map(({ text, outcome }) => [text, outcome]),
    [
      ["Подготавливаю состояние", "succeeded"],
      ["Нестабильный шаг остановлен", "failed"],
      ["Нестабильный шаг завершён", "succeeded"],
    ],
  );
  await engine.dispose();
  await ledger.close();
});

test("сохранённый change после reload проверяется без запуска нового агента", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-selected-resume");
  createOrchestratorReporter(ledger, "workspace-selected-resume").setChange({
    id: "selected-change",
  });
  await ledger.saveWorkflowCheckpoint("workspace-selected-resume", {
    version: 1,
    nextStepId: "select-change",
    state: { branch: "feature/resume-change", change: { id: "selected-change" } },
  });
  let verifyCalls = 0;
  let selectCalls = 0;
  const changeSelection = {
    async verify(_workspaceDirectory, changeId) {
      verifyCalls += 1;
      return { id: changeId };
    },
    async select() {
      selectCalls += 1;
      throw new Error("Новый агент не должен запускаться");
    },
  };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({ kind: "non-main", name: "feature/resume-change" }),
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-selected-resume",
    engineContext("/workspace/project", async () => requiredAgentProfiles(), changeSelection),
  );

  engine.command("workspace-selected-resume", "start");
  await settleWorkflow();

  assert.equal(ledger.get("workspace-selected-resume").lifecycle.status, "completed");
  assert.equal(ledger.get("workspace-selected-resume").change?.id, "selected-change");
  assert.equal(verifyCalls, 2);
  assert.equal(selectCalls, 0);
  await engine.dispose();
  await ledger.close();
});

test("после reload pending-сессия продолжает тот же артефакт", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-pending-artifact");
  createOrchestratorReporter(ledger, "workspace-pending-artifact").setChange({
    id: "selected-change",
  });
  const pendingArtifactSession = {
    artifactId: "risk-map",
    schemaName: "custom-flow",
    baselineCommit: "a".repeat(40),
  };
  await ledger.saveWorkflowCheckpoint("workspace-pending-artifact", {
    version: 1,
    nextStepId: "create-change-artifacts",
    state: {
      branch: "feature/recover-artifact",
      change: { id: "selected-change" },
      pendingArtifactSession,
    },
  });
  let inspectCalls = 0;
  let prepareCalls = 0;
  let selectCalls = 0;
  const resumedSessions = [];
  const changeArtifacts = {
    async inspect() {
      inspectCalls += 1;
      return { kind: "complete", schemaName: "custom-flow" };
    },
    async prepare() {
      prepareCalls += 1;
      throw new Error("Нельзя заменять pending-сессию новой");
    },
    async create(request) {
      resumedSessions.push(request.session);
      request.onAgentCreated("agent-recovered-artifact");
      const plan = { kind: "complete", schemaName: "custom-flow" };
      await request.onArtifactCompleted(plan);
      return plan;
    },
    async verifyApply() {},
  };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({ kind: "non-main", name: "feature/recover-artifact" }),
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-pending-artifact",
    engineContext(
      "/workspace/project",
      async () => requiredAgentProfiles(),
      {
        async verify(_workspace, changeId) {
          return { id: changeId };
        },
        async select() {
          selectCalls += 1;
          throw new Error("Выбор change не должен повторяться");
        },
      },
      async () => ({ kind: "available" }),
      changeArtifacts,
    ),
  );

  engine.command("workspace-pending-artifact", "start");
  await settleWorkflow();

  assert.equal(ledger.get("workspace-pending-artifact").lifecycle.status, "completed");
  assert.equal(inspectCalls, 1);
  assert.equal(prepareCalls, 0);
  assert.equal(selectCalls, 0);
  assert.deepEqual(resumedSessions, [pendingArtifactSession]);
  assert.equal(ledger.getWorkflowCheckpoint("workspace-pending-artifact"), null);
  await engine.dispose();
  await ledger.close();
});

test("после reload шаг публикации повторно согласует существующий PR", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-publication-resume");
  createOrchestratorReporter(ledger, "workspace-publication-resume").setChange({
    id: "selected-change",
  });
  await ledger.saveWorkflowCheckpoint("workspace-publication-resume", {
    version: 1,
    nextStepId: "publish-change",
    state: {
      branch: "feature/publication-resume",
      change: { id: "selected-change" },
      pendingArtifactSession: null,
    },
  });
  let selectCalls = 0;
  let publishCalls = 0;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({
      kind: "non-main",
      name: "feature/publication-resume",
    }),
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-publication-resume",
    engineContext(
      "/workspace/project",
      async () => requiredAgentProfiles(),
      {
        async verify(_workspace, selectedChangeId) {
          return { id: selectedChangeId };
        },
        async select() {
          selectCalls += 1;
          throw new Error("Выбор change не должен повторяться");
        },
      },
      async () => ({ kind: "available" }),
      completedChangeArtifacts(),
      {
        async publish(request) {
          publishCalls += 1;
          request.onAgentCreated("agent-publication-resume");
          return {
            number: 77,
            url: "https://github.com/example/project/pull/77",
            title: "Продолжить публикацию change",
          };
        },
      },
    ),
  );

  engine.command("workspace-publication-resume", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-publication-resume");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(selectCalls, 0);
  assert.equal(publishCalls, 1);
  assert.equal(
    snapshot.history.at(-4)?.text,
    "Pull request #77 опубликован: https://github.com/example/project/pull/77",
  );
  assert.equal(
    snapshot.history.at(-3)?.text,
    "Review OpenSpec change опубликован: openspec/changes/selected-change/review.md",
  );
  assert.equal(
    snapshot.history.at(-2)?.text,
    "В review нет нерешённых findings: openspec/changes/selected-change/review.md",
  );
  assert.equal(
    snapshot.history.at(-1)?.text,
    "В implementation review нет нерешённых findings: openspec/changes/selected-change/implementation-review.md",
  );
  assert.equal(ledger.getWorkflowCheckpoint("workspace-publication-resume"), null);
  await engine.dispose();
  await ledger.close();
});

test("существующий опубликованный review пропускает создание агента", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-existing-review");
  let reviewRuns = 0;
  const changeReview = {
    async plan(_workspaceDirectory, selectedChangeId, selectedBranch) {
      assert.equal(selectedChangeId, "selected-change");
      assert.equal(selectedBranch, "feature/existing-review");
      return {
        kind: "already-reviewed",
        reviewPath: "openspec/changes/selected-change/review.md",
      };
    },
    async run() {
      reviewRuns += 1;
      throw new Error("Агент review не должен запускаться повторно");
    },
  };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({ kind: "non-main", name: "feature/existing-review" }),
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-existing-review",
    engineContext(
      "/workspace/project",
      async () => requiredAgentProfiles(),
      immediateChangeSelection(),
      async () => ({ kind: "available" }),
      completedChangeArtifacts(),
      completedChangePublication(),
      changeReview,
    ),
  );

  engine.command("workspace-existing-review", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-existing-review");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(reviewRuns, 0);
  assert.equal(
    snapshot.history.at(-3)?.text,
    "Review OpenSpec change уже опубликован: openspec/changes/selected-change/review.md",
  );
  assert.equal(
    snapshot.history.at(-2)?.text,
    "В review нет нерешённых findings: openspec/changes/selected-change/review.md",
  );
  assert.equal(
    snapshot.history.at(-1)?.text,
    "В implementation review нет нерешённых findings: openspec/changes/selected-change/implementation-review.md",
  );
  assert.deepEqual(snapshot.history.at(-3)?.links, []);
  assert.deepEqual(snapshot.history.at(-2)?.links, []);
  assert.deepEqual(snapshot.history.at(-1)?.links, []);
  await engine.dispose();
  await ledger.close();
});

test("после reload review продолжает сохранённую baseline-сессию", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-review-resume");
  createOrchestratorReporter(ledger, "workspace-review-resume").setChange({
    id: "selected-change",
  });
  const pendingReviewSession = {
    changeId: "selected-change",
    branch: "feature/review-resume",
    baselineCommit: "d".repeat(40),
  };
  await ledger.saveWorkflowCheckpoint("workspace-review-resume", {
    version: 1,
    nextStepId: "review-change",
    state: {
      branch: "feature/review-resume",
      change: { id: "selected-change" },
      pendingArtifactSession: null,
      pendingReviewSession,
    },
  });
  let planCalls = 0;
  const resumedSessions = [];
  const changeReview = {
    async plan() {
      planCalls += 1;
      throw new Error("Baseline не должен вычисляться повторно");
    },
    async run(request) {
      resumedSessions.push(request.session);
      request.onAgentCreated("agent-review-resume");
      const review = {
        changeId: request.changeId,
        reviewPath: "openspec/changes/selected-change/review.md",
      };
      await request.onReviewCompleted(review);
      return review;
    },
  };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({ kind: "non-main", name: "feature/review-resume" }),
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-review-resume",
    engineContext(
      "/workspace/project",
      async () => requiredAgentProfiles(),
      immediateChangeSelection(),
      async () => ({ kind: "available" }),
      completedChangeArtifacts(),
      completedChangePublication(),
      changeReview,
    ),
  );

  engine.command("workspace-review-resume", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-review-resume");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(planCalls, 0);
  assert.deepEqual(resumedSessions, [pendingReviewSession]);
  assert.deepEqual(snapshot.history.at(-3)?.links, [
    {
      kind: "agent",
      agentId: "agent-review-resume",
      label: "Review change selected-change",
    },
  ]);
  assert.deepEqual(snapshot.history.at(-2)?.links, []);
  assert.deepEqual(snapshot.history.at(-1)?.links, []);
  assert.equal(ledger.getWorkflowCheckpoint("workspace-review-resume"), null);
  await engine.dispose();
  await ledger.close();
});

test("findings устраняются по одной отдельными High Sandbox агентами", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-finding-loop");
  const pendingFindingIds = ["F1", "F3"];
  const plannedFindingIds = [];
  const resolvedFindingIds = [];
  const resolutionProfiles = [];
  const changeFindingResolution = {
    async plan(_workspaceDirectory, changeId, branch) {
      const findingId = pendingFindingIds[0];
      assert.ok(findingId);
      plannedFindingIds.push(findingId);
      return {
        kind: "finding-required",
        findingId,
        session: {
          changeId,
          branch,
          findingId,
          baselineCommit: findingId === "F1" ? "1".repeat(40) : "3".repeat(40),
        },
      };
    },
    async run(request) {
      const findingId = pendingFindingIds.shift();
      assert.equal(request.session.findingId, findingId);
      assert.equal(request.profile.name, "High Sandbox");
      resolutionProfiles.push(request.profile.name);
      resolvedFindingIds.push(request.session.findingId);
      request.onAgentCreated(`agent-finding-${request.session.findingId}`);
      const completed = {
        changeId: request.changeId,
        findingId: request.session.findingId,
        remainingFindingIds: [...pendingFindingIds],
        commit: request.session.findingId === "F1" ? "a".repeat(40) : "b".repeat(40),
      };
      await request.onFindingResolved(completed);
      return completed;
    },
  };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({ kind: "non-main", name: "feature/finding-loop" }),
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-finding-loop",
    engineContext(
      "/workspace/project",
      async () => requiredAgentProfiles(),
      immediateChangeSelection(),
      async () => ({ kind: "available" }),
      completedChangeArtifacts(),
      completedChangePublication(),
      completedChangeReview(),
      changeFindingResolution,
    ),
  );

  engine.command("workspace-finding-loop", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-finding-loop");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.deepEqual(plannedFindingIds, ["F1", "F3"]);
  assert.deepEqual(resolvedFindingIds, ["F1", "F3"]);
  assert.deepEqual(resolutionProfiles, ["High Sandbox", "High Sandbox"]);
  assert.equal(snapshot.history.at(-3)?.text, "Устранена finding F1; осталось 1");
  assert.equal(snapshot.history.at(-2)?.text, "Устранена последняя finding review: F3");
  assert.deepEqual(snapshot.history.at(-3)?.links, [
    {
      kind: "agent",
      agentId: "agent-finding-F1",
      label: "Finding F1",
    },
  ]);
  assert.deepEqual(snapshot.history.at(-2)?.links, [
    {
      kind: "agent",
      agentId: "agent-finding-F3",
      label: "Finding F3",
    },
  ]);
  assert.deepEqual(snapshot.history.at(-1)?.links, []);
  assert.equal(ledger.getWorkflowCheckpoint("workspace-finding-loop"), null);
  await engine.dispose();
  await ledger.close();
});

test("implementation findings устраняются по одной отдельными High Sandbox агентами", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-implementation-finding-loop");
  const pendingFindingIds = ["F2", "F4"];
  const plannedFindingIds = [];
  const resolvedFindingIds = [];
  const implementationFindingResolution = {
    async plan(_workspaceDirectory, changeId, branch) {
      const findingId = pendingFindingIds[0];
      assert.ok(findingId);
      plannedFindingIds.push(findingId);
      return {
        kind: "finding-required",
        findingId,
        session: {
          changeId,
          branch,
          findingId,
          baselineCommit: findingId === "F2" ? "2".repeat(40) : "4".repeat(40),
        },
      };
    },
    async run(request) {
      const findingId = pendingFindingIds.shift();
      assert.equal(request.session.findingId, findingId);
      assert.equal(request.profile.name, "High Sandbox");
      resolvedFindingIds.push(request.session.findingId);
      request.onAgentCreated(`agent-implementation-finding-${request.session.findingId}`);
      const completed = {
        changeId: request.changeId,
        findingId: request.session.findingId,
        remainingFindingIds: [...pendingFindingIds],
        commit: request.session.findingId === "F2" ? "a".repeat(40) : "b".repeat(40),
      };
      await request.onFindingResolved(completed);
      return completed;
    },
  };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({
      kind: "non-main",
      name: "feature/implementation-finding-loop",
    }),
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-implementation-finding-loop",
    engineContext(
      "/workspace/project",
      async () => requiredAgentProfiles(),
      immediateChangeSelection(),
      async () => ({ kind: "available" }),
      completedChangeArtifacts(),
      completedChangePublication(),
      completedChangeReview(),
      completedChangeFindingResolution(),
      implementationFindingResolution,
    ),
  );

  engine.command("workspace-implementation-finding-loop", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-implementation-finding-loop");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.deepEqual(plannedFindingIds, ["F2", "F4"]);
  assert.deepEqual(resolvedFindingIds, ["F2", "F4"]);
  assert.equal(
    snapshot.history.at(-2)?.text,
    "Устранена implementation finding F2; осталось 1",
  );
  assert.equal(
    snapshot.history.at(-1)?.text,
    "Устранена последняя implementation finding: F4",
  );
  assert.deepEqual(snapshot.history.at(-2)?.links, [
    {
      kind: "agent",
      agentId: "agent-implementation-finding-F2",
      label: "Implementation finding F2",
    },
  ]);
  assert.deepEqual(snapshot.history.at(-1)?.links, [
    {
      kind: "agent",
      agentId: "agent-implementation-finding-F4",
      label: "Implementation finding F4",
    },
  ]);
  assert.equal(ledger.getWorkflowCheckpoint("workspace-implementation-finding-loop"), null);
  await engine.dispose();
  await ledger.close();
});

test("после reload finding продолжает сохранённую baseline-сессию", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-finding-resume");
  createOrchestratorReporter(ledger, "workspace-finding-resume").setChange({
    id: "selected-change",
  });
  const pendingFindingResolutionSession = {
    changeId: "selected-change",
    branch: "feature/finding-resume",
    findingId: "F7",
    baselineCommit: "7".repeat(40),
  };
  await ledger.saveWorkflowCheckpoint("workspace-finding-resume", {
    version: 1,
    nextStepId: "resolve-review-findings",
    state: {
      branch: "feature/finding-resume",
      change: { id: "selected-change" },
      pendingArtifactSession: null,
      pendingReviewSession: null,
      pendingFindingResolutionSession,
    },
  });
  let planCalls = 0;
  const resumedSessions = [];
  const changeFindingResolution = {
    async plan() {
      planCalls += 1;
      throw new Error("Finding и baseline не должны вычисляться повторно");
    },
    async run(request) {
      resumedSessions.push(request.session);
      assert.equal(request.profile.name, "High Sandbox");
      request.onAgentCreated("agent-finding-resume");
      const completed = {
        changeId: request.changeId,
        findingId: request.session.findingId,
        remainingFindingIds: [],
        commit: "e".repeat(40),
      };
      await request.onFindingResolved(completed);
      return completed;
    },
  };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({ kind: "non-main", name: "feature/finding-resume" }),
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-finding-resume",
    engineContext(
      "/workspace/project",
      async () => requiredAgentProfiles(),
      immediateChangeSelection(),
      async () => ({ kind: "available" }),
      completedChangeArtifacts(),
      completedChangePublication(),
      completedChangeReview(),
      changeFindingResolution,
    ),
  );

  engine.command("workspace-finding-resume", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-finding-resume");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(planCalls, 0);
  assert.deepEqual(resumedSessions, [pendingFindingResolutionSession]);
  assert.deepEqual(snapshot.history.at(-2)?.links, [
    {
      kind: "agent",
      agentId: "agent-finding-resume",
      label: "Finding F7",
    },
  ]);
  assert.deepEqual(snapshot.history.at(-1)?.links, []);
  assert.equal(ledger.getWorkflowCheckpoint("workspace-finding-resume"), null);
  await engine.dispose();
  await ledger.close();
});

test("после reload implementation finding продолжает сохранённую baseline-сессию", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-implementation-finding-resume");
  createOrchestratorReporter(ledger, "workspace-implementation-finding-resume").setChange({
    id: "selected-change",
  });
  const pendingImplementationFindingResolutionSession = {
    changeId: "selected-change",
    branch: "feature/implementation-finding-resume",
    findingId: "F8",
    baselineCommit: "8".repeat(40),
  };
  await ledger.saveWorkflowCheckpoint("workspace-implementation-finding-resume", {
    version: 1,
    nextStepId: "resolve-implementation-review-findings",
    state: {
      branch: "feature/implementation-finding-resume",
      change: { id: "selected-change" },
      pendingArtifactSession: null,
      pendingReviewSession: null,
      pendingFindingResolutionSession: null,
      pendingImplementationFindingResolutionSession,
    },
  });
  let planCalls = 0;
  const resumedSessions = [];
  const implementationFindingResolution = {
    async plan() {
      planCalls += 1;
      throw new Error("Implementation finding и baseline не должны вычисляться повторно");
    },
    async run(request) {
      resumedSessions.push(request.session);
      assert.equal(request.profile.name, "High Sandbox");
      request.onAgentCreated("agent-implementation-finding-resume");
      const completed = {
        changeId: request.changeId,
        findingId: request.session.findingId,
        remainingFindingIds: [],
        commit: "e".repeat(40),
      };
      await request.onFindingResolved(completed);
      return completed;
    },
  };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({
      kind: "non-main",
      name: "feature/implementation-finding-resume",
    }),
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-implementation-finding-resume",
    engineContext(
      "/workspace/project",
      async () => requiredAgentProfiles(),
      immediateChangeSelection(),
      async () => ({ kind: "available" }),
      completedChangeArtifacts(),
      completedChangePublication(),
      completedChangeReview(),
      completedChangeFindingResolution(),
      implementationFindingResolution,
    ),
  );

  engine.command("workspace-implementation-finding-resume", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-implementation-finding-resume");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(planCalls, 0);
  assert.deepEqual(resumedSessions, [pendingImplementationFindingResolutionSession]);
  assert.deepEqual(snapshot.history.at(-1)?.links, [
    {
      kind: "agent",
      agentId: "agent-implementation-finding-resume",
      label: "Implementation finding F8",
    },
  ]);
  assert.equal(ledger.getWorkflowCheckpoint("workspace-implementation-finding-resume"), null);
  await engine.dispose();
  await ledger.close();
});

test("пустой findings завершается до чтения профиля агента", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-no-findings");
  createOrchestratorReporter(ledger, "workspace-no-findings").setChange({
    id: "selected-change",
  });
  await ledger.saveWorkflowCheckpoint("workspace-no-findings", {
    version: 1,
    nextStepId: "resolve-review-findings",
    state: {
      branch: "feature/no-findings",
      change: { id: "selected-change" },
      pendingArtifactSession: null,
      pendingReviewSession: null,
      pendingFindingResolutionSession: null,
    },
  });
  let profileReads = 0;
  const engine = new OpenSpecOrchestratorEngine(ledger);
  engine.initialize(
    "workspace-no-findings",
    engineContext(
      "/workspace/project",
      async () => {
        profileReads += 1;
        throw new Error("Профили не должны читаться без findings");
      },
    ),
  );

  engine.command("workspace-no-findings", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-no-findings");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(profileReads, 0);
  assert.equal(
    snapshot.history.at(-2)?.text,
    "В review нет нерешённых findings: openspec/changes/selected-change/review.md",
  );
  assert.equal(
    snapshot.history.at(-1)?.text,
    "В implementation review нет нерешённых findings: openspec/changes/selected-change/implementation-review.md",
  );
  await engine.dispose();
  await ledger.close();
});

test("ошибка записи перехода оставляет runtime на предыдущем durable checkpoint", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const paseoHome = await temporaryHome(context);
  const workspaceId = "workspace-transition-write-error";
  let rejectTransition = true;
  const ledger = new OrchestratorLedger({
    paseoHome,
    async writer(_path, value) {
      if (rejectTransition && value.checkpoint?.nextStepId === "second") {
        throw new Error("диск временно недоступен");
      }
    },
  });
  await ledger.open(workspaceId);
  const firstStepStates = [];
  let secondStepRuns = 0;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    steps: [
      {
        id: "first",
        label: "Первый шаг",
        async run({ state }) {
          firstStepStates.push(state.branch);
          return {
            kind: "continue",
            next: "second",
            state: { branch: "feature/transition-write" },
            summary: "Первый шаг готов",
          };
        },
      },
      {
        id: "second",
        label: "Второй шаг",
        async run() {
          secondStepRuns += 1;
          return { kind: "complete", summary: "Второй шаг завершён" };
        },
      },
    ],
  });
  engine.initialize(workspaceId, engineContext());

  engine.command(workspaceId, "start");
  await settleWorkflow();
  assert.equal(ledger.get(workspaceId).lifecycle.status, "failed");
  assert.equal(ledger.getWorkflowCheckpoint(workspaceId)?.nextStepId, "first");
  assert.deepEqual(firstStepStates, [null]);
  assert.equal(secondStepRuns, 0);

  rejectTransition = false;
  engine.command(workspaceId, "retry");
  await settleWorkflow();
  assert.equal(ledger.get(workspaceId).lifecycle.status, "completed");
  assert.deepEqual(firstStepStates, [null, null]);
  assert.equal(secondStepRuns, 1);
  await engine.dispose();
  await ledger.close();
});

test("ошибка checkpointState откатывает публичный change и retry к durable-состоянию", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const paseoHome = await temporaryHome(context);
  let rejectCheckpoint = true;
  const ledger = new OrchestratorLedger({
    paseoHome,
    async writer(_path, value) {
      if (rejectCheckpoint && value.checkpoint?.state.change?.id === "selected-change") {
        throw new Error("диск временно недоступен");
      }
    },
  });
  await ledger.open("workspace-selection-write-error");
  let persistenceRejected = false;
  const receivedChanges = [];
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    steps: [
      {
        id: "persist-change",
        label: "Сохраняю change",
        async run({ checkpointState, state }) {
          receivedChanges.push(state.change);
          try {
            await checkpointState({
              ...state,
              change: { id: "selected-change" },
              pendingArtifactSession: {
                artifactId: "risk-map",
                schemaName: "custom-flow",
                baselineCommit: "b".repeat(40),
              },
            });
          } catch {
            persistenceRejected = true;
            return {
              kind: "halt",
              summary: "Change не сохранён",
              message: "Повторите сохранение",
            };
          }
          return { kind: "complete", summary: "Change сохранён" };
        },
      },
    ],
  });
  engine.initialize("workspace-selection-write-error", engineContext());

  engine.command("workspace-selection-write-error", "start");
  await settleWorkflow();

  assert.equal(persistenceRejected, true);
  assert.equal(ledger.get("workspace-selection-write-error").change, null);
  assert.equal(
    ledger.getWorkflowCheckpoint("workspace-selection-write-error")?.nextStepId,
    "persist-change",
  );

  rejectCheckpoint = false;
  engine.command("workspace-selection-write-error", "retry");
  await settleWorkflow();

  assert.deepEqual(receivedChanges, [null, null]);
  assert.equal(ledger.get("workspace-selection-write-error").lifecycle.status, "completed");
  assert.equal(ledger.get("workspace-selection-write-error").change?.id, "selected-change");
  await engine.dispose();
  await ledger.close();
});

test("clear отменяет активный шаг и удаляет историю и checkpoint", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-clear");
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    steps: [
      {
        id: "long-step",
        label: "Долгий шаг",
        async run({ signal }) {
          await Promise.race([
            waiting,
            new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
          ]);
          return { kind: "complete" };
        },
      },
    ],
  });
  engine.initialize("workspace-clear", engineContext());
  engine.command("workspace-clear", "start");
  await nextEventLoop();
  engine.command("workspace-clear", "clear");
  release();
  await settleWorkflow();

  const cleared = ledger.get("workspace-clear");
  assert.equal(cleared.lifecycle.status, "idle");
  assert.equal(cleared.currentAction, null);
  assert.deepEqual(cleared.history, []);
  assert.equal(ledger.getWorkflowCheckpoint("workspace-clear"), null);
  await ledger.flush();
  await engine.dispose();
  await ledger.close();
});

test("после завершения и clear новый запуск начинается с первого шага", async (context) => {
  const paseoHome = await temporaryHome(context);
  const workspaceId = "workspace-fresh-start";
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open(workspaceId);
  let runs = 0;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    steps: [
      {
        id: "first",
        label: "Первый шаг",
        async run() {
          runs += 1;
          return { kind: "complete", summary: `Запуск ${runs}` };
        },
      },
    ],
  });
  engine.initialize(workspaceId, engineContext());

  engine.command(workspaceId, "start");
  await settleWorkflow();
  engine.command(workspaceId, "start");
  await settleWorkflow();
  assert.equal(runs, 2);
  assert.deepEqual(
    ledger.get(workspaceId).history.map(({ text }) => text),
    ["Запуск 1", "Запуск 2"],
  );

  engine.command(workspaceId, "clear");
  engine.command(workspaceId, "start");
  await settleWorkflow();
  assert.equal(runs, 3);
  assert.deepEqual(ledger.get(workspaceId).history.map(({ text }) => text), ["Запуск 3"]);
  await engine.dispose();
  await ledger.close();
});

test("неизвестный переход останавливает workflow с понятной ошибкой конфигурации", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-unknown-transition");
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    steps: [
      {
        id: "broken-transition",
        label: "Проверяю переход",
        run: async () => ({
          kind: "continue",
          next: "missing-step",
          summary: "Готовлю неизвестный переход",
        }),
      },
    ],
  });
  engine.initialize("workspace-unknown-transition", engineContext());

  engine.command("workspace-unknown-transition", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-unknown-transition");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.equal(snapshot.lifecycle.availableCommand, "retry");
  assert.match(snapshot.lifecycle.message, /Следующий шаг «missing-step» не найден/);
  assert.equal(snapshot.history.at(-1)?.outcome, "failed");
  await engine.dispose();
  await ledger.close();
});

test("engine отменяет активный шаг через AbortSignal при dispose", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-cancellation");
  let stepSignal;
  let markStepStarted;
  const stepStarted = new Promise((resolve) => {
    markStepStarted = resolve;
  });
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    steps: [
      {
        id: "long-step",
        label: "Долгий шаг",
        run: async ({ signal }) => {
          stepSignal = signal;
          markStepStarted();
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return { kind: "complete", summary: "Шаг отменён" };
        },
      },
    ],
  });
  engine.initialize("workspace-cancellation", engineContext());

  engine.command("workspace-cancellation", "start");
  await stepStarted;
  assert.equal(stepSignal.aborted, false);

  await engine.dispose();
  assert.equal(stepSignal.aborted, true);
  await settleWorkflow();
  assert.equal(ledger.get("workspace-cancellation").lifecycle.status, "idle");
  assert.equal(ledger.get("workspace-cancellation").history.at(-1)?.outcome, "cancelled");
  await ledger.close();
});

test("неожиданная ошибка шага переводит workflow в failed с безопасным сообщением", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-error");
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    steps: [
      {
        id: "unexpected-error",
        label: "Нестабильный шаг",
        run: async () => {
          throw new Error("внутренние детали не должны попасть в UI");
        },
      },
    ],
  });
  engine.initialize("workspace-error", engineContext());

  engine.command("workspace-error", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-error");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.equal(snapshot.lifecycle.availableCommand, "retry");
  assert.match(snapshot.lifecycle.message, /Нестабильный шаг/);
  assert.doesNotMatch(snapshot.lifecycle.message, /внутренние детали/);
  assert.equal(snapshot.history.at(-1)?.outcome, "failed");
  await engine.dispose();
  await ledger.close();
});

test("на main ветке workflow останавливается, а retry повторяет проверку", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-1");
  let decision = { kind: "main", name: "main" };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => decision,
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize("workspace-1", engineContext());

  engine.command("workspace-1", "start");
  await settleWorkflow();
  let snapshot = ledger.get("workspace-1");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.equal(snapshot.lifecycle.availableCommand, "retry");
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Все обязательные профили агентов доступны", "succeeded"],
    ["Git-ветка main — запуск запрещён", "failed"],
  ]);

  decision = { kind: "non-main", name: "feature/after-switch" };
  engine.command("workspace-1", "retry");
  await settleWorkflow();
  snapshot = ledger.get("workspace-1");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Все обязательные профили агентов доступны", "succeeded"],
    ["Git-ветка main — запуск запрещён", "failed"],
    ["Git-ветка: feature/after-switch", "succeeded"],
    ["Рабочее дерево Git чистое", "succeeded"],
    ["Mise toolchain доступен", "succeeded"],
    ["OpenSpec change готов к apply: selected-change", "succeeded"],
    ["Pull request #42 опубликован: https://github.com/example/project/pull/42", "succeeded"],
    [
      "Review OpenSpec change опубликован: openspec/changes/selected-change/review.md",
      "succeeded",
    ],
    [
      "В review нет нерешённых findings: openspec/changes/selected-change/review.md",
      "succeeded",
    ],
    [
      "В implementation review нет нерешённых findings: openspec/changes/selected-change/implementation-review.md",
      "succeeded",
    ],
  ]);
  await engine.dispose();
  await ledger.close();
});

test("detached HEAD и ошибка Git требуют retry", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-1");
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({ kind: "detached" }),
  });
  engine.initialize("workspace-1", engineContext());

  engine.command("workspace-1", "start");
  await settleWorkflow();
  let snapshot = ledger.get("workspace-1");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.match(snapshot.lifecycle.message, /ветка не определена/);

  const failingEngine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => {
      throw new Error("git unavailable");
    },
  });
  await ledger.open("workspace-2");
  failingEngine.initialize("workspace-2", engineContext());
  failingEngine.command("workspace-2", "start");
  await settleWorkflow();
  snapshot = ledger.get("workspace-2");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.match(snapshot.lifecycle.message, /Не удалось определить Git-ветку/);

  await engine.dispose();
  await failingEngine.dispose();
  await ledger.close();
});

test("пауза во время проверки ветки применяется после безопасной точки", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-1");
  let resolveBranch;
  let markBranchStarted;
  const branchStarted = new Promise((resolve) => {
    markBranchStarted = resolve;
  });
  let calls = 0;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => {
      calls += 1;
      if (calls > 1) {
        return { kind: "non-main", name: "feature/paused" };
      }
      return new Promise((resolve) => {
        resolveBranch = resolve;
        markBranchStarted();
      });
    },
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize("workspace-1", engineContext());

  engine.command("workspace-1", "start");
  await branchStarted;
  engine.command("workspace-1", "pause");
  resolveBranch({ kind: "non-main", name: "feature/paused" });
  await settleWorkflow();
  assert.equal(ledger.get("workspace-1").lifecycle.status, "paused");

  engine.command("workspace-1", "resume");
  await settleWorkflow();
  assert.equal(ledger.get("workspace-1").lifecycle.status, "completed");
  assert.equal(calls, 2);
  await engine.dispose();
  await ledger.close();
});

test("пауза не прерывает диалог выбора и применяется перед публикацией", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-selection-pause");
  let finishSelection;
  let selectionStarted;
  const started = new Promise((resolve) => {
    selectionStarted = resolve;
  });
  const changeSelection = {
    verify: async (_workspace, changeId) => ({ id: changeId }),
    async select({ onAgentCreated, onChangeSelected }) {
      onAgentCreated("agent-selection-pause");
      selectionStarted();
      return new Promise((resolve) => {
        finishSelection = async () => {
          const change = { id: "selected-change" };
          await onChangeSelected(change);
          resolve(change);
        };
      });
    },
  };
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => ({ kind: "non-main", name: "feature/selection-pause" }),
    worktreeProbe: async () => ({ kind: "clean" }),
  });
  engine.initialize(
    "workspace-selection-pause",
    engineContext("/workspace/project", async () => requiredAgentProfiles(), changeSelection),
  );

  engine.command("workspace-selection-pause", "start");
  await started;
  engine.command("workspace-selection-pause", "pause");
  assert.equal(ledger.get("workspace-selection-pause").lifecycle.status, "pausing");
  await finishSelection();
  await settleWorkflow();

  assert.equal(ledger.get("workspace-selection-pause").lifecycle.status, "paused");
  assert.equal(ledger.get("workspace-selection-pause").change?.id, "selected-change");
  engine.command("workspace-selection-pause", "resume");
  await settleWorkflow();
  assert.equal(ledger.get("workspace-selection-pause").lifecycle.status, "completed");
  await engine.dispose();
  await ledger.close();
});

test("после reload незавершённая проверка ветки становится отменённой", async (context) => {
  const paseoHome = await temporaryHome(context);
  const firstLedger = new OrchestratorLedger({ paseoHome });
  await firstLedger.open("workspace-1");
  const reporter = createOrchestratorReporter(firstLedger, "workspace-1");
  reporter.setLifecycle({ status: "running", availableCommand: "pause" });
  reporter.beginAction({ text: "Определяю Git-ветку" });
  await firstLedger.close();

  const restoredLedger = new OrchestratorLedger({ paseoHome });
  await restoredLedger.open("workspace-1");
  const engine = new OpenSpecOrchestratorEngine(restoredLedger);
  engine.initialize("workspace-1", engineContext());

  const snapshot = restoredLedger.get("workspace-1");
  assert.equal(snapshot.lifecycle.status, "idle");
  assert.equal(snapshot.currentAction, null);
  assert.equal(snapshot.history.at(-1)?.outcome, "cancelled");
  await engine.dispose();
  await restoredLedger.close();
});

test("контроллер передаёт контекст и создаёт агента в том же workspace", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  const calls = [];
  const engine = {
    initialize(workspaceId, engineContext) {
      calls.push(["initialize", workspaceId, engineContext]);
    },
    command(workspaceId, command) {
      calls.push(["command", workspaceId, command]);
    },
    dispose() {
      calls.push(["dispose"]);
    },
  };
  const controller = new OrchestratorController({
    ledger,
    createEngine: () => engine,
  });
  let workspaceSnapshot = {
    projectCustomName: "Платёжный сервис",
    projectDisplayName: "payments",
    title: "Проверка авторизации",
    name: "feature/auth",
  };
  let configuredProfiles = requiredAgentProfiles();
  let configReads = 0;
  let globalAgentCreates = 0;
  const workspaceAgentCreates = [];
  const workspace = {
    directory: "/tmp/workspace-1",
    refresh: async () => workspaceSnapshot,
    agents: {
      create: async (options) => {
        workspaceAgentCreates.push(options);
        throw new Error("workspace agent creator called");
      },
    },
  };
  const paseo = {
    agents: {
      create: async () => {
        globalAgentCreates += 1;
        throw new Error("global agent creator must not be called");
      },
    },
    config: {
      get: async () => {
        configReads += 1;
        return { config: { agentProfiles: configuredProfiles } };
      },
    },
    workspaces: {
      ref: () => workspace,
    },
  };

  const initial = await controller.get("workspace-1", paseo);
  const started = await controller.control("workspace-1", initial.revision, "start", paseo);
  assert.equal(started.status, "accepted");
  const [initializeCall, initializedWorkspaceId, initializedContext] = calls[0];
  assert.equal(initializeCall, "initialize");
  assert.equal(initializedWorkspaceId, "workspace-1");
  assert.equal(initializedContext.workspaceDirectory, "/tmp/workspace-1");
  assert.deepEqual(initializedContext.workspaceDisplay, {
    projectName: "Платёжный сервис",
    workspaceName: "Проверка авторизации",
  });
  assert.equal(typeof initializedContext.refreshWorkspaceDisplay, "function");
  assert.equal(typeof initializedContext.miseToolchain, "function");
  assert.equal(typeof initializedContext.changeArtifacts.inspect, "function");
  assert.equal(typeof initializedContext.changeArtifacts.create, "function");
  assert.equal(typeof initializedContext.changePublication.publish, "function");
  assert.deepEqual(await initializedContext.readAgentProfiles(), configuredProfiles);
  configuredProfiles = undefined;
  assert.deepEqual(await initializedContext.readAgentProfiles(), []);
  configuredProfiles = requiredAgentProfiles().slice(0, 1);
  assert.deepEqual(await initializedContext.readAgentProfiles(), configuredProfiles);
  assert.equal(configReads, 3);
  assert.deepEqual(calls[1], ["command", "workspace-1", "start"]);

  workspaceSnapshot = {
    ...workspaceSnapshot,
    title: "Ручное название после переименования",
  };
  assert.deepEqual(await initializedContext.refreshWorkspaceDisplay(), {
    projectName: "Платёжный сервис",
    workspaceName: "Ручное название после переименования",
  });

  const lowSandbox = requiredAgentProfiles().find(
    ({ name }) => name === "Low Sandbox",
  );
  await assert.rejects(
    initializedContext.changeSelection.select({
      workspaceDirectory: "/tmp/workspace-1",
      profile: lowSandbox,
      signal: new AbortController().signal,
      onAgentCreated() {},
      async onChangeSelected() {},
    }),
    /workspace agent creator called/,
  );
  assert.equal(globalAgentCreates, 0);
  assert.equal(workspaceAgentCreates.length, 1);
  assert.equal("cwd" in workspaceAgentCreates[0], false);

  const cleared = await controller.control("workspace-1", initial.revision, "clear", paseo);
  assert.equal(cleared.status, "accepted");
  assert.deepEqual(calls[2], ["command", "workspace-1", "clear"]);

  ledger.update("workspace-1", (projection) => projection);
  const stale = await controller.control("workspace-1", initial.revision, "start", paseo);
  assert.equal(stale.status, "rejected");
  assert.equal(stale.reason, "stale");
  await controller.close();
});

test("контроллер не создаёт ledger для недоступной рабочей области", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  const engine = new OpenSpecOrchestratorEngine(ledger);
  const controller = new OrchestratorController({
    ledger,
    createEngine: () => engine,
  });
  const paseo = {
    workspaces: {
      ref: () => ({ directory: null, refresh: async () => undefined }),
    },
  };

  await assert.rejects(
    controller.get("missing-workspace", paseo),
    /Рабочая область недоступна/,
  );
  assert.equal(ledger.has("missing-workspace"), false);
  await controller.close();
});
