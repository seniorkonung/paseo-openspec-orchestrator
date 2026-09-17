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
  // Небольшая пауза оставляет время завершить fsync без привязки к диску.
  await new Promise((resolve) => setTimeout(resolve, 50));
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
    async select({ onAgentCreated, onChangeSelected }) {
      onAgentCreated("agent-change-selection");
      const change = { id: changeId };
      await onChangeSelected(change);
      return change;
    },
  };
}

function engineContext(
  workspaceDirectory = "/workspace/project",
  readAgentProfiles = async () => requiredAgentProfiles(),
  changeSelection = immediateChangeSelection(),
) {
  const workspaceDisplay = { projectName: null, workspaceName: null };
  return {
    workspaceDirectory,
    workspaceDisplay,
    refreshWorkspaceDisplay: async () => workspaceDisplay,
    readAgentProfiles,
    changeSelection,
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
  assert.deepEqual(directories, ["/workspace/project"]);
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.equal(snapshot.change?.id, "selected-change");
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Все обязательные профили агентов доступны", "succeeded"],
    ["Git-ветка: feature/orchestrator", "succeeded"],
    ["Рабочее дерево Git чистое", "succeeded"],
    ["Выбран OpenSpec change: selected-change", "succeeded"],
  ]);
  assert.deepEqual(snapshot.history.at(-1)?.links, [
    {
      kind: "agent",
      agentId: "agent-change-selection",
      label: "Выбор OpenSpec change",
    },
  ]);
  engine.dispose();
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
    ["Все обязательные профили агентов доступны", "succeeded"],
    ["Git-ветка: feature/clean-check", "succeeded"],
    ["Рабочее дерево Git чистое", "succeeded"],
    ["Выбран OpenSpec change: selected-change", "succeeded"],
  ]);
  engine.dispose();
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
  assert.equal(profileReads, 3);
  assert.equal(branchReads, 1);
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Отсутствуют профили агентов: Orchestrator", "failed"],
    ["Все обязательные профили агентов доступны", "succeeded"],
    ["Git-ветка: feature/profile-check", "succeeded"],
    ["Рабочее дерево Git чистое", "succeeded"],
    ["Выбран OpenSpec change: selected-change", "succeeded"],
  ]);
  engine.dispose();
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
  engine.dispose();
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
          profiles.find(({ name }) => name === "Medium Sandbox").thinkingOptionId = " ";
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
  assert.match(snapshot.lifecycle.message, /Medium Sandbox \(thinkingOptionId\)/);
  assert.equal(profileReads, 2);
  assert.equal(selectCalls, 0);
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
  assert.deepEqual(seenStates, [{ branch: "feature/from-step", change: null }]);
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Первый шаг завершён", "succeeded"],
    ["Второй шаг завершён", "succeeded"],
  ]);
  engine.dispose();
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
  engine.dispose();
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
    state: { branch: "feature/resume", change: null },
  });

  engine.dispose();
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
  resumedEngine.dispose();
  await restoredLedger.close();
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
  const engine = new OpenSpecOrchestratorEngine(ledger);
  engine.initialize(
    "workspace-selected-resume",
    engineContext("/workspace/project", async () => requiredAgentProfiles(), changeSelection),
  );

  engine.command("workspace-selected-resume", "start");
  await settleWorkflow();

  assert.equal(ledger.get("workspace-selected-resume").lifecycle.status, "completed");
  assert.equal(ledger.get("workspace-selected-resume").change?.id, "selected-change");
  assert.equal(verifyCalls, 1);
  assert.equal(selectCalls, 0);
  await engine.dispose();
  await ledger.close();
});

test("ошибка записи выбранного change откатывает проекцию и checkpoint", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({
    paseoHome,
    async writer(_path, value) {
      if (value.change?.id === "selected-change") {
        throw new Error("диск временно недоступен");
      }
    },
  });
  await ledger.open("workspace-selection-write-error");
  let persistenceRejected = false;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    steps: [
      {
        id: "persist-change",
        label: "Сохраняю change",
        async run({ persistChange }) {
          try {
            await persistChange({ id: "selected-change" });
          } catch {
            persistenceRejected = true;
          }
          return {
            kind: "halt",
            summary: "Change не сохранён",
            message: "Повторите сохранение",
          };
        },
      },
    ],
  });
  engine.initialize("workspace-selection-write-error", engineContext());

  engine.command("workspace-selection-write-error", "start");
  await settleWorkflow();

  assert.equal(persistenceRejected, true);
  assert.equal(ledger.get("workspace-selection-write-error").change, null);
  assert.equal(ledger.getWorkflowCheckpoint("workspace-selection-write-error"), null);
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
  engine.dispose();
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
  engine.dispose();
  await ledger.close();
});

test("engine отменяет активный шаг через AbortSignal при dispose", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-cancellation");
  let stepSignal;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    steps: [
      {
        id: "long-step",
        label: "Долгий шаг",
        run: async ({ signal }) => {
          stepSignal = signal;
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return { kind: "complete", summary: "Шаг отменён" };
        },
      },
    ],
  });
  engine.initialize("workspace-cancellation", engineContext());

  engine.command("workspace-cancellation", "start");
  await nextEventLoop();
  assert.equal(stepSignal.aborted, false);

  engine.dispose();
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
  engine.dispose();
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
    ["Все обязательные профили агентов доступны", "succeeded"],
    ["Git-ветка: feature/after-switch", "succeeded"],
    ["Рабочее дерево Git чистое", "succeeded"],
    ["Выбран OpenSpec change: selected-change", "succeeded"],
  ]);
  engine.dispose();
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

  engine.dispose();
  failingEngine.dispose();
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
  assert.equal(calls, 1);
  engine.dispose();
  await ledger.close();
});

test("пауза не прерывает диалог выбора, а terminal completion имеет приоритет", async (context) => {
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

  assert.equal(ledger.get("workspace-selection-pause").lifecycle.status, "completed");
  assert.equal(ledger.get("workspace-selection-pause").change?.id, "selected-change");
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
  engine.dispose();
  await restoredLedger.close();
});

test("контроллер передаёт engine директорию и названия проекта с workspace", async (context) => {
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
  const paseo = {
    config: {
      get: async () => {
        configReads += 1;
        return { config: { agentProfiles: configuredProfiles } };
      },
    },
    workspaces: {
      ref: () => ({
        directory: "/tmp/workspace-1",
        refresh: async () => workspaceSnapshot,
      }),
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
