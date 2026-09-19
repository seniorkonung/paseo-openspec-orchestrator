import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenSpecOrchestratorEngine } from "../server/openspec-orchestrator-engine.ts";
import { OrchestratorLedger } from "../server/orchestrator-ledger.ts";

const changeBranch = "change/engine-check";
const planningBranch = "planning/engine-check/initial";

async function temporaryHome(context) {
  const directory = await mkdtemp(join(tmpdir(), "openspec-engine-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function settleWorkflow() {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

function engineContext(workflow) {
  return {
    workspaceDisplay: { projectName: null, workspaceName: null },
    refreshWorkspaceDisplay: async () => ({
      projectName: null,
      workspaceName: null,
    }),
    workflow,
  };
}

async function createRuntime(context, workspaceId, workflow, ledgerOptions = {}) {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome, ...ledgerOptions });
  await ledger.open(workspaceId);
  const engine = new OpenSpecOrchestratorEngine(ledger);
  engine.initialize(workspaceId, engineContext(workflow));
  context.after(async () => {
    await engine.dispose();
    await ledger.close();
  });
  return { engine, ledger, paseoHome };
}

test("движок передаёт типизированное состояние между явными шагами", async (context) => {
  const received = [];
  const workflow = {
    startStepId: "root",
    steps: [
      {
        id: "root",
        label: "Сохраняю ветки",
        async run() {
          return {
            kind: "continue",
            next: "planning",
            state: {
              changeBranch,
              activeBranch: planningBranch,
              change: { id: "engine-check" },
            },
            summary: "Ветки сохранены",
          };
        },
      },
      {
        id: "planning",
        label: "Читаю ветки",
        async run({ state }) {
          received.push({
            changeBranch: state.changeBranch,
            activeBranch: state.activeBranch,
            change: state.change,
          });
          return { kind: "complete", summary: "Состояние прочитано" };
        },
      },
    ],
  };
  const { engine, ledger } = await createRuntime(
    context,
    "workspace-state",
    workflow,
  );

  engine.command("workspace-state", "start");
  await settleWorkflow();

  assert.equal(ledger.get("workspace-state").lifecycle.status, "completed");
  assert.deepEqual(received, [{
    changeBranch,
    activeBranch: planningBranch,
    change: { id: "engine-check" },
  }]);
});

test("движок следует циклическому графу до явного завершения", async (context) => {
  let hasFinding = true;
  const workflow = {
    startStepId: "review",
    steps: [
      {
        id: "review",
        label: "Проверяю результат",
        async run() {
          return hasFinding
            ? { kind: "continue", next: "resolve", summary: "Найдено замечание" }
            : { kind: "complete", summary: "Review завершён" };
        },
      },
      {
        id: "resolve",
        label: "Устраняю замечание",
        async run() {
          hasFinding = false;
          return { kind: "continue", next: "review", summary: "Замечание устранено" };
        },
      },
    ],
  };
  const { engine, ledger } = await createRuntime(
    context,
    "workspace-loop",
    workflow,
  );

  engine.command("workspace-loop", "start");
  await settleWorkflow();

  assert.deepEqual(
    ledger.get("workspace-loop").history.map(({ text }) => text),
    ["Найдено замечание", "Замечание устранено", "Review завершён"],
  );
});

test("неизвестный переход завершается безопасной конфигурационной ошибкой", async (context) => {
  const workflow = {
    startStepId: "broken",
    steps: [{
      id: "broken",
      label: "Проверяю граф",
      async run() {
        return {
          kind: "continue",
          next: "missing",
          summary: "Переход подготовлен",
        };
      },
    }],
  };
  const { engine, ledger } = await createRuntime(
    context,
    "workspace-broken",
    workflow,
  );

  engine.command("workspace-broken", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-broken");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.match(snapshot.lifecycle.message, /Следующий шаг «missing» не найден/);
  assert.equal(snapshot.history.at(-1)?.outcome, "failed");
});

test("неожиданная ошибка шага не раскрывает внутреннее сообщение", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const workflow = {
    startStepId: "unstable",
    steps: [{
      id: "unstable",
      label: "Нестабильный шаг",
      async run() {
        throw new Error("секретные внутренние детали");
      },
    }],
  };
  const { engine, ledger } = await createRuntime(
    context,
    "workspace-error",
    workflow,
  );

  engine.command("workspace-error", "start");
  await settleWorkflow();

  const snapshot = ledger.get("workspace-error");
  assert.equal(snapshot.lifecycle.status, "failed");
  assert.match(snapshot.lifecycle.message, /Нестабильный шаг/);
  assert.doesNotMatch(snapshot.lifecycle.message, /секретные/);
});

test("dispose отменяет активный шаг через AbortSignal", async (context) => {
  let receivedSignal;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const workflow = {
    startStepId: "long",
    steps: [{
      id: "long",
      label: "Долгий шаг",
      async run({ signal }) {
        receivedSignal = signal;
        markStarted();
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
        return { kind: "complete", summary: "Шаг остановлен" };
      },
    }],
  };
  const { engine, ledger } = await createRuntime(
    context,
    "workspace-dispose",
    workflow,
  );

  engine.command("workspace-dispose", "start");
  await started;
  assert.equal(receivedSignal.aborted, false);
  await engine.dispose();
  assert.equal(receivedSignal.aborted, true);
  await settleWorkflow();
  assert.equal(ledger.get("workspace-dispose").history.at(-1)?.outcome, "cancelled");
});

test("сбой записи перехода сохраняет предыдущий durable checkpoint", async (context) => {
  context.mock.method(console, "error", () => undefined);
  let rejectTransition = true;
  let firstRuns = 0;
  let secondRuns = 0;
  const workflow = {
    startStepId: "first",
    steps: [
      {
        id: "first",
        label: "Первый шаг",
        async run() {
          firstRuns += 1;
          return {
            kind: "continue",
            next: "second",
            state: { changeBranch, activeBranch: changeBranch },
            summary: "Первый шаг готов",
          };
        },
      },
      {
        id: "second",
        label: "Второй шаг",
        async run() {
          secondRuns += 1;
          return { kind: "complete", summary: "Второй шаг готов" };
        },
      },
    ],
  };
  const { engine, ledger } = await createRuntime(
    context,
    "workspace-write-failure",
    workflow,
    {
      async writer(_path, value) {
        if (rejectTransition && value.checkpoint?.nextStepId === "second") {
          throw new Error("disk unavailable");
        }
      },
    },
  );

  engine.command("workspace-write-failure", "start");
  await settleWorkflow();
  assert.equal(ledger.get("workspace-write-failure").lifecycle.status, "failed");
  assert.equal(
    ledger.getWorkflowCheckpoint("workspace-write-failure")?.nextStepId,
    "first",
  );
  assert.equal(firstRuns, 1);
  assert.equal(secondRuns, 0);

  rejectTransition = false;
  engine.command("workspace-write-failure", "retry");
  await settleWorkflow();
  assert.equal(ledger.get("workspace-write-failure").lifecycle.status, "completed");
  assert.equal(firstRuns, 2);
  assert.equal(secondRuns, 1);
});

test("retry получает последнее состояние checkpoint внутри шага", async (context) => {
  const received = [];
  const pending = {
    artifactId: "proposal",
    schemaName: "spec-driven",
    baselineCommit: "a".repeat(40),
  };
  const workflow = {
    startStepId: "recoverable",
    steps: [{
      id: "recoverable",
      label: "Восстанавливаемый шаг",
      async run({ checkpointState, state }) {
        received.push(state.pendingArtifactSession);
        if (!state.pendingArtifactSession) {
          await checkpointState({ ...state, pendingArtifactSession: pending });
          return {
            kind: "halt",
            summary: "Требуется повтор",
            message: "Нажмите «Повторить»",
          };
        }
        return { kind: "complete", summary: "Сессия восстановлена" };
      },
    }],
  };
  const { engine, ledger } = await createRuntime(
    context,
    "workspace-inner-checkpoint",
    workflow,
  );

  engine.command("workspace-inner-checkpoint", "start");
  await settleWorkflow();
  engine.command("workspace-inner-checkpoint", "retry");
  await settleWorkflow();

  assert.deepEqual(received, [null, pending]);
  assert.equal(
    ledger.get("workspace-inner-checkpoint").lifecycle.status,
    "completed",
  );
});
