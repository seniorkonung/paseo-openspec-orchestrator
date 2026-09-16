import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DemoOrchestratorEngine } from "../server/demo-orchestrator-engine.ts";
import { OrchestratorController } from "../server/orchestrator-controller.ts";
import { OrchestratorLedger } from "../server/orchestrator-ledger.ts";
import { createOrchestratorReporter } from "../server/orchestrator-reporter.ts";

async function temporaryHome(context) {
  const directory = await mkdtemp(join(tmpdir(), "openspec-demo-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const nextEventLoop = () => new Promise((resolve) => setImmediate(resolve));

function controlledSleep() {
  const pending = [];
  return {
    sleep: () => new Promise((resolve) => pending.push(resolve)),
    finishNext() {
      const resolve = pending.shift();
      assert.ok(resolve, "ожидалось активное demo-действие");
      resolve();
    },
  };
}

test("demo применяет паузу на безопасной точке и продолжает без нового действия", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-1");
  const clock = controlledSleep();
  const engine = new DemoOrchestratorEngine(ledger, {
    sleep: clock.sleep,
    steps: [
      { text: "Первое действие", durationMs: 1 },
      { text: "Второе действие", durationMs: 1 },
    ],
  });
  engine.initialize("workspace-1");

  engine.command("workspace-1", "start");
  await nextEventLoop();
  assert.equal(ledger.get("workspace-1").currentAction?.text, "Первое действие");

  engine.command("workspace-1", "pause");
  assert.equal(ledger.get("workspace-1").lifecycle.status, "pausing");
  clock.finishNext();
  await nextEventLoop();
  assert.equal(ledger.get("workspace-1").lifecycle.status, "paused");
  assert.equal(ledger.get("workspace-1").currentAction, null);
  assert.deepEqual(ledger.get("workspace-1").history.map(({ text }) => text), [
    "Первое действие",
  ]);

  engine.command("workspace-1", "resume");
  await nextEventLoop();
  assert.equal(ledger.get("workspace-1").currentAction?.text, "Второе действие");
  clock.finishNext();
  await nextEventLoop();
  assert.equal(ledger.get("workspace-1").lifecycle.status, "completed");
  assert.deepEqual(ledger.get("workspace-1").history.map(({ text }) => text), [
    "Первое действие",
    "Второе действие",
  ]);

  engine.dispose();
  await ledger.close();
});

test("demo при повторном запуске дописывает ту же workspace-ленту", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  await ledger.open("workspace-1");
  const engine = new DemoOrchestratorEngine(ledger, {
    sleep: async () => undefined,
    steps: [{ text: "Быстрое действие", durationMs: 0 }],
  });
  engine.initialize("workspace-1");

  engine.command("workspace-1", "start");
  await nextEventLoop();
  await nextEventLoop();
  engine.command("workspace-1", "start");
  await nextEventLoop();
  await nextEventLoop();

  const snapshot = ledger.get("workspace-1");
  assert.equal(snapshot.lifecycle.status, "completed");
  assert.deepEqual(snapshot.history.map(({ text }) => text), [
    "Быстрое действие",
    "Быстрое действие",
  ]);
  engine.dispose();
  await ledger.close();
});

test("незавершённое demo-действие после reload становится отменённым", async (context) => {
  const paseoHome = await temporaryHome(context);
  const firstLedger = new OrchestratorLedger({ paseoHome });
  await firstLedger.open("workspace-1");
  const reporter = createOrchestratorReporter(firstLedger, "workspace-1", {
    createId: () => "interrupted-action",
  });
  reporter.setLifecycle({ status: "running", availableCommand: "pause" });
  reporter.beginAction({ text: "Прерванное действие" });
  await firstLedger.close();

  const restoredLedger = new OrchestratorLedger({ paseoHome });
  await restoredLedger.open("workspace-1");
  const engine = new DemoOrchestratorEngine(restoredLedger);
  engine.initialize("workspace-1");

  const snapshot = restoredLedger.get("workspace-1");
  assert.equal(snapshot.lifecycle.status, "idle");
  assert.equal(snapshot.currentAction, null);
  assert.equal(snapshot.history.at(-1)?.outcome, "cancelled");
  assert.equal(snapshot.history.at(-1)?.text, "Прерванное действие");
  engine.dispose();
  await restoredLedger.close();
});

test("контроллер отклоняет stale revision и недоступную команду", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  const clock = controlledSleep();
  const engine = new DemoOrchestratorEngine(ledger, {
    sleep: clock.sleep,
    steps: [{ text: "Управляемое действие", durationMs: 1 }],
  });
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

  const stale = await controller.control("workspace-1", initial.revision, "pause", paseo);
  assert.equal(stale.status, "rejected");
  assert.equal(stale.reason, "stale");

  const notAllowed = await controller.control(
    "workspace-1",
    ledger.get("workspace-1").revision,
    "resume",
    paseo,
  );
  assert.equal(notAllowed.status, "rejected");
  assert.equal(notAllowed.reason, "not_allowed");

  await nextEventLoop();
  const running = ledger.get("workspace-1");
  const pausing = await controller.control("workspace-1", running.revision, "pause", paseo);
  assert.equal(pausing.status, "accepted");
  assert.equal(pausing.snapshot.lifecycle.status, "pausing");
  clock.finishNext();
  await nextEventLoop();
  assert.equal(ledger.get("workspace-1").lifecycle.status, "paused");
  await controller.close();
});

test("контроллер не создаёт ledger для недоступной рабочей области", async (context) => {
  const paseoHome = await temporaryHome(context);
  const ledger = new OrchestratorLedger({ paseoHome });
  const engine = new DemoOrchestratorEngine(ledger);
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
