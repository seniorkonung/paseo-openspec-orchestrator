import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenSpecOrchestratorEngine } from "../server/openspec-orchestrator-engine.ts";
import { readGitBranch } from "../server/git-branch.ts";
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
  await nextEventLoop();
  await nextEventLoop();
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
  });
  engine.initialize("workspace-1", { workspaceDirectory: "/workspace/project" });

  engine.command("workspace-1", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-1");
  assert.deepEqual(directories, ["/workspace/project"]);
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Git-ветка: feature/orchestrator", "succeeded"],
  ]);
  engine.dispose();
  await ledger.close();
});

test("workflow выполняет отдельные шаги по порядку и передаёт состояние дальше", async (context) => {
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
          summary: "Первый шаг завершён",
          state: { branch: "feature/from-step" },
        }),
      },
      {
        id: "second-step",
        label: "Второй шаг",
        run: async ({ state }) => {
          seenStates.push({ ...state });
          return { kind: "continue", summary: "Второй шаг завершён" };
        },
      },
    ],
  });
  engine.initialize("workspace-steps", { workspaceDirectory: "/workspace/project" });

  engine.command("workspace-steps", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-steps");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.deepEqual(seenStates, [{ branch: "feature/from-step" }]);
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Первый шаг завершён", "succeeded"],
    ["Второй шаг завершён", "succeeded"],
  ]);
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
          return { kind: "continue", summary: "Шаг отменён" };
        },
      },
    ],
  });
  engine.initialize("workspace-cancellation", { workspaceDirectory: "/workspace/project" });

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
  engine.initialize("workspace-error", { workspaceDirectory: "/workspace/project" });

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
  });
  engine.initialize("workspace-1", { workspaceDirectory: "/workspace/project" });

  engine.command("workspace-1", "start");
  await settleWorkflow();
  let snapshot = ledger.get("workspace-1");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.equal(snapshot.lifecycle.availableCommand, "retry");
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Git-ветка main — запуск запрещён", "failed"],
  ]);

  decision = { kind: "non-main", name: "feature/after-switch" };
  engine.command("workspace-1", "retry");
  await settleWorkflow();
  snapshot = ledger.get("workspace-1");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.deepEqual(snapshot.history.map(({ text, outcome }) => [text, outcome]), [
    ["Git-ветка main — запуск запрещён", "failed"],
    ["Git-ветка: feature/after-switch", "succeeded"],
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
  engine.initialize("workspace-1", { workspaceDirectory: "/workspace/project" });

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
  failingEngine.initialize("workspace-2", { workspaceDirectory: "/workspace/project" });
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
  let calls = 0;
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    branchProbe: async () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveBranch = resolve;
      });
    },
  });
  engine.initialize("workspace-1", { workspaceDirectory: "/workspace/project" });

  engine.command("workspace-1", "start");
  await nextEventLoop();
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
  engine.initialize("workspace-1", { workspaceDirectory: "/workspace/project" });

  const snapshot = restoredLedger.get("workspace-1");
  assert.equal(snapshot.lifecycle.status, "idle");
  assert.equal(snapshot.currentAction, null);
  assert.equal(snapshot.history.at(-1)?.outcome, "cancelled");
  engine.dispose();
  await restoredLedger.close();
});

test("контроллер передаёт engine директорию workspace и сохраняет защиту revision", async (context) => {
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
  const paseo = {
    workspaces: {
      ref: () => ({
        directory: "/tmp/workspace-1",
        refresh: async () => undefined,
      }),
    },
  };

  const initial = await controller.get("workspace-1", paseo);
  const started = await controller.control("workspace-1", initial.revision, "start", paseo);
  assert.equal(started.status, "accepted");
  assert.deepEqual(calls[0], [
    "initialize",
    "workspace-1",
    { workspaceDirectory: "/tmp/workspace-1" },
  ]);
  assert.deepEqual(calls[1], ["command", "workspace-1", "start"]);

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
