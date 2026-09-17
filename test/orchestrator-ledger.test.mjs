import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  getLedgerPath,
  OrchestratorLedger,
  resolvePaseoHome,
} from "../server/orchestrator-ledger.ts";
import {
  createOrchestratorReporter,
  runAction,
} from "../server/orchestrator-reporter.ts";
import {
  workflowCheckpointSchema,
  workflowStateSchema,
} from "../server/workflow/types.ts";

async function temporaryHome(context) {
  const directory = await mkdtemp(join(tmpdir(), "openspec-ledger-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function pendingReviewSession(changeId, parentBranch) {
  return {
    changeId,
    parentBranch,
    reviewBranch: `${parentBranch}-review`,
    baselineCommit: "b".repeat(40),
    repositoryHost: "github.com",
    repositoryNameWithOwner: "example/project",
    repositoryUrl: "https://github.com/example/project",
    parentPullRequestNumber: 42,
  };
}

test("checkpoint версии 1 неподдерживаем, а версия 2 заполняет default", () => {
  assert.throws(
    () =>
      workflowCheckpointSchema.parse({
        version: 1,
        nextStepId: "select-change",
        state: { branch: "feature/legacy", change: { id: "legacy-change" } },
      }),
  );
  assert.deepEqual(
    workflowCheckpointSchema.parse({
      version: 2,
      nextStepId: "select-change",
      state: { branch: "feature/legacy", change: { id: "legacy-change" } },
    }),
    {
      version: 2,
      nextStepId: "select-change",
      state: {
        branch: "feature/legacy",
        change: { id: "legacy-change" },
        pendingArtifactSession: null,
        pendingReviewSession: null,
        pendingFindingResolutionSession: null,
        pendingImplementationFindingResolutionSession: null,
      },
    },
  );
});

test("workflow не принимает несколько незавершённых агентских сессий", () => {
  assert.throws(
    () =>
      workflowStateSchema.parse({
        branch: "feature/conflicting-sessions",
        change: { id: "conflicting-sessions" },
        pendingArtifactSession: {
          artifactId: "proposal",
          schemaName: "spec-driven",
          baselineCommit: "a".repeat(40),
        },
        pendingReviewSession: pendingReviewSession(
          "conflicting-sessions",
          "feature/conflicting-sessions",
        ),
      }),
    /одновременно восстанавливать несколько агентских сессий/,
  );
  assert.throws(
    () =>
      workflowStateSchema.parse({
        branch: "feature/conflicting-sessions",
        change: { id: "conflicting-sessions" },
        pendingArtifactSession: null,
        pendingReviewSession: null,
        pendingFindingResolutionSession: {
          changeId: "conflicting-sessions",
          branch: "feature/conflicting-sessions",
          findingId: "F1",
          baselineCommit: "c".repeat(40),
        },
        pendingImplementationFindingResolutionSession: {
          changeId: "conflicting-sessions",
          branch: "feature/conflicting-sessions",
          findingId: "F2",
          baselineCommit: "d".repeat(40),
        },
      }),
    /одновременно восстанавливать несколько агентских сессий/,
  );
  assert.throws(
    () =>
      workflowStateSchema.parse({
        branch: "feature/conflicting-sessions",
        change: { id: "conflicting-sessions" },
        pendingArtifactSession: null,
        pendingReviewSession: pendingReviewSession(
          "conflicting-sessions",
          "feature/conflicting-sessions",
        ),
        pendingFindingResolutionSession: {
          changeId: "conflicting-sessions",
          branch: "feature/conflicting-sessions",
          findingId: "F1",
          baselineCommit: "c".repeat(40),
        },
      }),
    /одновременно восстанавливать несколько агентских сессий/,
  );
});

test("reporter хранит ровно одно действие и завершает handle один раз", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-1");
  let identifier = 0;
  const reporter = createOrchestratorReporter(ledger, "workspace-1", {
    createId: () => `action-${++identifier}`,
    now: () => new Date("2026-09-16T10:00:00.000Z"),
  });
  reporter.setLifecycle({ status: "running", availableCommand: "pause" });

  const action = reporter.beginAction({
    text: "Первое действие",
    links: [{ kind: "agent", agentId: "agent-1", label: "Исполнитель" }],
  });
  assert.throws(
    () => reporter.beginAction({ text: "Конкурирующее действие" }),
    /пока текущее не завершено/,
  );
  action.update({ text: "Обновлённое действие" });
  action.succeed();
  assert.throws(() => action.succeed(), /уже завершено/);

  const snapshot = ledger.get("workspace-1");
  assert.equal(snapshot.currentAction, null);
  assert.equal(snapshot.history.length, 1);
  assert.equal(snapshot.history[0].text, "Обновлённое действие");
  assert.equal(snapshot.history[0].outcome, "succeeded");
  assert.equal(snapshot.history[0].links[0].agentId, "agent-1");
  await ledger.close();
});

test("reporter фиксирует failure, cancellation и ошибку runAction по порядку", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-1");
  let identifier = 0;
  const reporter = createOrchestratorReporter(ledger, "workspace-1", {
    createId: () => `action-${++identifier}`,
  });
  reporter.setLifecycle({ status: "running", availableCommand: "pause" });

  reporter.beginAction({ text: "Ошибка" }).fail();
  reporter.beginAction({ text: "Отмена" }).cancel();
  await assert.rejects(
    runAction(reporter, { text: "Async-ошибка" }, async () => {
      throw new Error("ожидаемый сбой");
    }),
    /ожидаемый сбой/,
  );

  assert.deepEqual(
    ledger.get("workspace-1").history.map(({ text, outcome }) => [text, outcome]),
    [
      ["Ошибка", "failed"],
      ["Отмена", "cancelled"],
      ["Async-ошибка", "failed"],
    ],
  );
  await ledger.close();
});

test("ledger атомарно сохраняется и восстанавливает единую workspace-ленту", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace/с пробелом");
  let identifier = 0;
  const reporter = createOrchestratorReporter(ledger, "workspace/с пробелом", {
    createId: () => `action-${++identifier}`,
  });
  reporter.setLifecycle({ status: "running", availableCommand: "pause" });
  reporter.setChange({ id: "change-a", title: "Первый change" });
  reporter.beginAction({ text: "Действие A" }).succeed();
  reporter.setChange({ id: "change-b", title: "Второй change" });
  reporter.beginAction({ text: "Действие B" }).succeed();
  reporter.setLifecycle({ status: "completed", availableCommand: "start" });
  await ledger.flush();

  const path = getLedgerPath("workspace/с пробелом", paseoHome);
  assert.equal(path.includes("workspace/с пробелом"), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  await ledger.close();

  const restored = new OrchestratorLedger({ paseoHome });
  const snapshot = await restored.open("workspace/с пробелом");
  assert.equal(snapshot.change?.id, "change-b");
  assert.deepEqual(snapshot.history.map(({ text }) => text), ["Действие A", "Действие B"]);
  assert.equal(snapshot.lifecycle.status, "completed");
  await restored.close();
});

test("ledger сохраняет checkpoint workflow и полностью очищает его вместе с историей", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-checkpoint");

  ledger.update("workspace-checkpoint", (projection) => ({
    ...projection,
    change: { id: "change-a" },
  }));
  await ledger.saveWorkflowCheckpoint("workspace-checkpoint", {
    version: 2,
    nextStepId: "review-change",
    state: { branch: "feature/checkpoint", change: null },
  });
  assert.deepEqual(ledger.getWorkflowCheckpoint("workspace-checkpoint"), {
    version: 2,
    nextStepId: "review-change",
    state: {
      branch: "feature/checkpoint",
      change: null,
      pendingArtifactSession: null,
      pendingReviewSession: null,
      pendingFindingResolutionSession: null,
      pendingImplementationFindingResolutionSession: null,
    },
  });

  const cleared = ledger.clear("workspace-checkpoint");
  assert.equal(cleared.change, null);
  assert.deepEqual(cleared.history, []);
  assert.equal(ledger.getWorkflowCheckpoint("workspace-checkpoint"), null);
  await ledger.flush();
  await ledger.close();

  const restored = new OrchestratorLedger({ paseoHome });
  const snapshot = await restored.open("workspace-checkpoint");
  assert.equal(snapshot.change, null);
  assert.deepEqual(snapshot.history, []);
  assert.equal(restored.getWorkflowCheckpoint("workspace-checkpoint"), null);
  await restored.close();
});

test("PASEO_HOME поддерживает переменную окружения и домашний префикс", () => {
  assert.equal(resolvePaseoHome({ PASEO_HOME: "/var/tmp/custom-paseo" }), "/var/tmp/custom-paseo");
  assert.equal(resolvePaseoHome({ PASEO_HOME: "~/.custom-paseo" }).endsWith("/.custom-paseo"), true);
});

test("повреждённый ledger не перезаписывается автоматически", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const paseoHome = await temporaryHome(context);
  const path = getLedgerPath("workspace-1", paseoHome);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{ повреждённый json\n", "utf8");

  const ledger = new OrchestratorLedger({ paseoHome });
  const loaded = await ledger.open("workspace-1");
  assert.equal(loaded.persistence.status, "degraded");
  createOrchestratorReporter(ledger, "workspace-1").setChange({ id: "change-a" });
  await ledger.close();

  assert.equal(await readFile(path, "utf8"), "{ повреждённый json\n");
});

test("явная очистка восстанавливает повреждённый ledger", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const paseoHome = await temporaryHome(context);
  const path = getLedgerPath("workspace-1", paseoHome);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{ повреждённый json\n", "utf8");

  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-1");
  const cleared = ledger.clear("workspace-1");
  assert.equal(cleared.persistence.status, "ready");
  await ledger.flush();
  await ledger.close();

  const restored = new OrchestratorLedger({ paseoHome });
  const snapshot = await restored.open("workspace-1");
  assert.equal(snapshot.persistence.status, "ready");
  assert.deepEqual(snapshot.history, []);
  await restored.close();
});

test("семантически несовместимый ledger переходит в read-only degraded", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const paseoHome = await temporaryHome(context);
  const path = getLedgerPath("workspace-1", paseoHome);
  await mkdir(dirname(path), { recursive: true });
  const source = JSON.stringify({
    version: 1,
    workspaceId: "workspace-1",
    revision: 7,
    change: null,
    lifecycle: { status: "idle", availableCommand: "start" },
    currentAction: {
      id: "несовместимое-действие",
      text: "Не должно быть активно в idle",
      startedAt: "2026-09-16T10:00:00.000Z",
      links: [],
    },
    history: [],
  });
  await writeFile(path, source, "utf8");

  const ledger = new OrchestratorLedger({ paseoHome });
  const snapshot = await ledger.open("workspace-1");
  assert.equal(snapshot.persistence.status, "degraded");
  assert.equal(snapshot.currentAction, null);
  createOrchestratorReporter(ledger, "workspace-1").setChange({ id: "change-a" });
  await ledger.close();
  assert.equal(await readFile(path, "utf8"), source);
});

test("после ошибки записи ledger остаётся в памяти и повторяет полный snapshot", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const paseoHome = await temporaryHome(context);
  let failWrites = true;
  const writes = [];
  const ledger = new OrchestratorLedger({
    paseoHome,
    writer: async (_path, value) => {
      writes.push(value);
      if (failWrites) throw new Error("диск недоступен");
    },
  });
  await ledger.open("workspace-1");
  const reporter = createOrchestratorReporter(ledger, "workspace-1");
  reporter.setChange({ id: "change-a" });
  await ledger.flush();
  assert.equal(ledger.get("workspace-1").persistence.status, "degraded");

  failWrites = false;
  reporter.setChange({ id: "change-b" });
  await ledger.flush();
  assert.equal(ledger.get("workspace-1").persistence.status, "ready");
  assert.equal(writes.at(-1).change.id, "change-b");
  await ledger.close();
});

test("после временной ошибки чтения ledger сохраняет in-memory change и обе истории", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const paseoHome = await temporaryHome(context);
  const persisted = JSON.stringify({
    version: 1,
    workspaceId: "workspace-1",
    revision: 8,
    change: { id: "old-change", title: "Старый change" },
    lifecycle: { status: "completed", availableCommand: "start" },
    currentAction: null,
    history: [
      {
        id: "old-action",
        text: "Сохранённое действие",
        startedAt: "2026-09-16T09:00:00.000Z",
        finishedAt: "2026-09-16T09:00:01.000Z",
        outcome: "succeeded",
        links: [],
      },
    ],
  });
  let readAttempt = 0;
  const writes = [];
  const ledger = new OrchestratorLedger({
    paseoHome,
    reader: async () => {
      readAttempt += 1;
      if (readAttempt === 1) {
        const error = new Error("временная ошибка чтения");
        error.code = "EIO";
        throw error;
      }
      return persisted;
    },
    writer: async (_path, value) => writes.push(value),
  });

  const unavailable = await ledger.open("workspace-1");
  assert.equal(unavailable.persistence.status, "degraded");
  const reporter = createOrchestratorReporter(ledger, "workspace-1", {
    createId: () => "new-action",
  });
  reporter.setLifecycle({ status: "running", availableCommand: "pause" });
  reporter.beginAction({ text: "Новое действие" }).succeed();
  reporter.setChange(null);
  reporter.setLifecycle({ status: "completed", availableCommand: "start" });
  await ledger.flush();

  const recovered = ledger.get("workspace-1");
  assert.equal(recovered.persistence.status, "ready");
  assert.equal(recovered.change, null);
  assert.deepEqual(recovered.history.map(({ id }) => id), ["old-action", "new-action"]);
  assert.equal(writes.at(-1).change, null);
  assert.equal(writes.at(-1).history.length, 2);
  await ledger.close();
});

test("long-poll возвращает полный новый snapshot и ограничивает ожидателей", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({
    paseoHome,
    waitDurationMs: 5,
    maximumWaiters: 1,
  });
  const initial = await ledger.open("workspace-1");

  const unchanged = await ledger.wait("workspace-1", initial.revision);
  assert.deepEqual(unchanged, { status: "unchanged", revision: initial.revision });

  const waiting = ledger.wait("workspace-1", initial.revision);
  await assert.rejects(
    ledger.wait("workspace-1", initial.revision),
    /Слишком много одновременных ожиданий/,
  );
  const reporter = createOrchestratorReporter(ledger, "workspace-1");
  reporter.setChange({ id: "change-a" });
  const changed = await waiting;
  assert.equal(changed.status, "changed");
  assert.equal(changed.snapshot.change.id, "change-a");

  const oldRevision = changed.snapshot.revision;
  reporter.setChange({ id: "change-b" });
  reporter.setChange({ id: "change-c" });
  const caughtUp = await ledger.wait("workspace-1", oldRevision);
  assert.equal(caughtUp.status, "changed");
  assert.equal(caughtUp.snapshot.change.id, "change-c");
  await ledger.close();
});

test("long-poll ограничивает суммарное число ожидателей", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({
    paseoHome,
    waitDurationMs: 100,
    maximumWaiters: 2,
    maximumTotalWaiters: 1,
  });
  const first = await ledger.open("workspace-1");
  const second = await ledger.open("workspace-2");
  const waiting = ledger.wait("workspace-1", first.revision);
  await assert.rejects(
    ledger.wait("workspace-2", second.revision),
    /Слишком много одновременных ожиданий/,
  );
  await ledger.close();
  assert.equal((await waiting).status, "unchanged");
});
