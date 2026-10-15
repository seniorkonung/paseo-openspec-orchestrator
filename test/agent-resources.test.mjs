import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentResources } from "../server/agent-resources.ts";
import { AgentResourceRegistry } from "../server/agent-resource-registry.ts";

async function fixture(context) {
  const home = await mkdtemp(join(tmpdir(), "agent-resources-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const registry = new AgentResourceRegistry(home);
  const snapshots = new Map();
  const archived = [];
  const cleaned = [];
  const stopped = [];
  const commands = [];
  let archiveFailure = false;
  let processFailure = false;
  const paseo = { agents: {
    async list() { return { entries: [...snapshots.values()].filter((agent) => !agent.archivedAt).map((agent) => ({ agent })), pageInfo: {} }; },
    ref(id) { return {
      id,
      async refresh() { const agent = snapshots.get(id); return agent ? { agent, project: null } : null; },
      async archive() {
        archived.push(id);
        if (archiveFailure) throw new Error("Сбой демона");
        const agent = snapshots.get(id);
        agent.archivedAt = new Date().toISOString();
        return { archivedAt: agent.archivedAt };
      },
    }; },
  } };
  const workspace = { id: "workspace-1", agents: { async create(options) {
    assert.equal((await new AgentResourceRegistry(home).list()).some(({ agentId }) => agentId === options.agentId), true);
    snapshots.set(options.agentId, { id: options.agentId, labels: options.labels, workspaceId: "workspace-1", archivedAt: null, status: "running" });
    return paseo.agents.ref(options.agentId);
  } } };
  const cleanProcesses = async (ids) => {
    cleaned.push([...ids]);
    if (processFailure) throw new Error("Процесс не завершился");
  };
  const command = async (executable, args) => {
    assert.equal(executable, "paseo");
    commands.push([...args]);
    const agent = snapshots.get(args.at(-1));
    assert.ok(agent, "Команда адресована существующему агенту");
    if (args[1] === "stop") {
      stopped.push(agent.id);
      agent.status = "idle";
    } else if (args[1] === "update") {
      const [name, value] = args[3].split("=");
      agent.labels = { ...agent.labels, [name]: value };
    } else assert.fail("Неожиданная команда");
    return { stdout: "{}", stderr: "" };
  };
  let elapsed = 0;
  const waits = [];
  const warnings = [];
  const cleanupOptions = {
    clock: { now: () => elapsed, async sleep(ms) { waits.push(ms); elapsed += ms; } },
    logger: { warn(message, details) { warnings.push({ message, ...details }); } },
  };
  const resources = new AgentResources({ ...cleanupOptions, registry, cleanProcesses, command });
  return { home, registry, resources, paseo, workspace, snapshots, archived, cleaned, cleanProcesses, stopped, commands, command,
    cleanupOptions, waits, warnings,
    setArchiveFailure(value) { archiveFailure = value; }, setProcessFailure(value) { processFailure = value; } };
}

test("временный сбой архивации устраняется автоматически в общей процедуре освобождения", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  const ref = value.paseo.agents.ref;
  let attempts = 0;
  value.paseo.agents.ref = (id) => {
    const handle = ref(id);
    return { ...handle, async archive() {
      attempts++;
      if (attempts === 1) throw new Error("Демон временно недоступен");
      return handle.archive();
    } };
  };
  const first = value.resources.release(agent.id, value.paseo, "archive");
  const second = value.resources.release(agent.id, value.paseo, "preserve");
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(attempts, 2);
  assert.deepEqual(value.waits, [1_000]);
  assert.deepEqual(await value.registry.list(), []);
  assert.equal(value.warnings[0].operation, "archive-agent");
  assert.equal(value.warnings[0].attempt, 1);
  assert.match(JSON.stringify(value.warnings[0]), /Демон временно недоступен/u);
});

test("временный сбой очистки процессов не повторяет успешную архивацию", async (context) => {
  const value = await fixture(context);
  let attempts = 0;
  const resources = new AgentResources({ ...value.cleanupOptions, registry: value.registry, command: value.command,
    async cleanProcesses(ids) {
      await value.cleanProcesses(ids);
      if (++attempts === 1) throw new Error("Процесс ещё завершается");
    },
  });
  const agent = await resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  await resources.release(agent.id, value.paseo, "archive");
  assert.equal(attempts, 2);
  assert.deepEqual(value.archived, [agent.id]);
  assert.deepEqual(await value.registry.list(), []);
});

test("автоматическая очистка MCP сохраняет активный workflow без уведомлений и повторной работы", async (context) => {
  const { createManagedAgentSession } = await import("../server/managed-agent-session.ts");
  const { OpenSpecOrchestratorEngine } = await import("../server/openspec-orchestrator-engine.ts");
  const { OrchestratorLedger } = await import("../server/orchestrator-ledger.ts");
  const value = await fixture(context);
  const notifications = [];
  const ledger = new OrchestratorLedger({ paseoHome: value.home });
  await ledger.open(value.workspace.id);
  const engine = new OpenSpecOrchestratorEngine(ledger, {
    notifications: { async notify(_workspaceId, notification) { notifications.push(notification); return true; } },
  });
  context.after(async () => { await engine.dispose(); await ledger.close(); });
  let retryStarted;
  const waiting = new Promise((resolve) => { retryStarted = resolve; });
  let resumeRetry;
  const retryAllowed = new Promise((resolve) => { resumeRetry = resolve; });
  context.after(() => resumeRetry());
  let scopeCalls = 0;
  let hostCalls = 0;
  let work = 0;
  let next = 0;
  const resources = new AgentResources({ ...value.cleanupOptions, registry: value.registry,
    command: value.command, cleanProcesses: value.cleanProcesses,
    clock: { ...value.cleanupOptions.clock, async sleep(ms) {
      retryStarted();
      await retryAllowed;
      await value.cleanupOptions.clock.sleep(ms);
    } },
  });
  engine.initialize(value.workspace.id, {
    workspaceDisplay: { projectName: null, workspaceName: null },
    refreshWorkspaceDisplay: async () => ({ projectName: null, workspaceName: null }),
    workflow: { startStepId: "agent", steps: [
      { id: "agent", label: "Выполняю задачу", run: (step) => resources.runStage(value.workspace.id, value.paseo, async () => {
        work++;
        const session = createManagedAgentSession({ signal: step.signal,
          host: { async close() { hostCalls++; } },
          updateNotificationLabel: async () => {}, agentDrainTimeoutMs: 10, logContext: "тест", logger: { warn() {} },
          releaseAgent: (agent, mode, closer) => resources.release(agent.id, value.paseo, mode, closer),
        });
        await session.openScope(() => ({ async close() {
          if (++scopeCalls === 1) throw new Error("MCP временно занят");
        } }));
        try {
          await session.launchAgent(() => resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } }), () => {});
          await step.checkpointState({ ...step.state, pendingArtifactSession: {
            artifactId: "proposal", schemaName: "spec-driven", baselineCommit: "a".repeat(40),
          } });
          session.complete("Готово");
          return { kind: "continue", next: "next", summary: await session.waitForCompletion() };
        } finally { await session.close(); }
      }) },
      { id: "next", label: "Продолжаю", async run() { next++; return { kind: "complete", summary: "Готово" }; } },
    ] },
  });
  engine.command(value.workspace.id, "start");
  await waiting;
  assert.equal(ledger.get(value.workspace.id).lifecycle.status, "running");
  assert.equal(ledger.get(value.workspace.id).lifecycle.availableCommand, "pause");
  assert.deepEqual(notifications, []);
  assert.equal(next, 0);
  assert.ok(ledger.getWorkflowCheckpoint(value.workspace.id).state.pendingArtifactSession);
  resumeRetry();
  const deadline = Date.now() + 3_000;
  while (ledger.get(value.workspace.id).lifecycle.status !== "completed") {
    assert.ok(Date.now() < deadline, "Workflow не продолжился после очистки");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(work, 1);
  assert.equal(next, 1);
  assert.equal(scopeCalls, 2);
  assert.equal(hostCalls, 1);
  assert.equal(value.archived.length, 1);
  assert.equal(notifications.some(({ kind }) => kind === "retry"), false);
  assert.deepEqual(await value.registry.list(), []);
});

test("временный сбой остановки при отмене сохраняет сессию и завершает очистку автоматически", async (context) => {
  const value = await fixture(context);
  let stops = 0;
  const resources = new AgentResources({ ...value.cleanupOptions, registry: value.registry, cleanProcesses: value.cleanProcesses,
    async command(executable, args, options) {
      if (args[1] === "stop" && ++stops === 1) throw new Error("Демон ещё завершает ход");
      return value.command(executable, args, options);
    },
  });
  const agent = await resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  await resources.release(agent.id, value.paseo, "preserve");
  assert.equal(stops, 2);
  assert.deepEqual(value.archived, []);
  assert.equal(value.snapshots.get(agent.id).labels["openspec-preserved"], "true");
  assert.deepEqual(await value.registry.list(), []);
});

test("восстановление после перезапуска автоматически повторяет очистку сохранённого режима", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  await value.registry.beginRelease(agent.id, "archive");
  let attempts = 0;
  const restarted = new AgentResources({ ...value.cleanupOptions,
    registry: new AgentResourceRegistry(value.home), command: value.command,
    async cleanProcesses(ids) {
      if (++attempts === 1) throw new Error("Процессы ещё завершаются");
      await value.cleanProcesses(ids);
    },
  });
  await restarted.initialize(value.paseo);
  assert.equal(attempts, 2);
  assert.deepEqual(value.archived, [agent.id]);
  assert.deepEqual(await new AgentResourceRegistry(value.home).list(), []);
});

test("поздний потомок между попытками очищается до перехода к следующему этапу", async (context) => {
  const value = await fixture(context);
  let attempts = 0;
  const resources = new AgentResources({ ...value.cleanupOptions, registry: value.registry, command: value.command,
    async cleanProcesses(ids) {
      await value.cleanProcesses(ids);
      if (++attempts === 1) {
        value.snapshots.set("late-retry-child", { id: "late-retry-child", status: "running", archivedAt: null,
          labels: { "parent-agent-id": ids[0] } });
        throw new Error("Потомок появился во время очистки");
      }
    },
  });
  const agent = await resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  await resources.release(agent.id, value.paseo, "archive");
  assert.deepEqual(value.archived, [agent.id, "late-retry-child"]);
  assert.ok(value.cleaned.some((ids) => ids.includes("late-retry-child")));
  await resources.assertReleased(value.workspace.id);
});

test("вложенная очистка использует остаток общего срока и сохраняет исходную причину", async (context) => {
  const value = await fixture(context);
  let elapsed = 0;
  const waits = [];
  const resources = new AgentResources({ ...value.cleanupOptions, registry: value.registry,
    command: value.command, cleanProcesses: value.cleanProcesses,
    clock: { now: () => elapsed, async sleep(ms) { waits.push(ms); elapsed += ms; } },
  });
  const agent = await resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  const cause = new Error("MCP не подтвердил закрытие");
  let closeCalls = 0;
  let failure;
  await assert.rejects(resources.runStage(value.workspace.id, value.paseo, async () => {}), /активна/u);
  await assert.rejects(resources.release(agent.id, value.paseo, "archive", async (budget) => {
    closeCalls++;
    if (closeCalls === 1) elapsed = 59_750;
    assert.equal(budget.timeoutMs(), 250);
    throw cause;
  }), (error) => {
    failure = error;
    assert.match(error.message, /MCP не подтвердил закрытие/u);
    return true;
  });
  assert.deepEqual(waits, [250]);
  assert.equal(elapsed, 60_000);
  assert.equal((await value.registry.list())[0].release, "archive");
  await assert.rejects(resources.assertReleased(value.workspace.id), (error) => error === failure);
});

test("последовательное закрытие scope и host имеет общий срок без тайм-аута на всю последовательность", async (context) => {
  const { createManagedAgentSession } = await import("../server/managed-agent-session.ts");
  const value = await fixture(context);
  const resources = new AgentResources({ ...value.cleanupOptions, registry: value.registry,
    command: value.command, cleanProcesses: value.cleanProcesses, cleanupTimeoutMs: 30,
  });
  let scopeCalls = 0;
  let hostCalls = 0;
  const session = createManagedAgentSession({ signal: new AbortController().signal,
    host: { async close() { hostCalls++; await new Promise((resolve) => setTimeout(resolve, 20)); } },
    updateNotificationLabel: async () => {}, agentDrainTimeoutMs: 10, cleanupTimeoutMs: 30,
    logContext: "последовательная очистка", logger: { warn() {} },
    releaseAgent: (agent, mode, closer) => resources.release(agent.id, value.paseo, mode, closer),
  });
  await session.openScope(() => ({ async close() {
    scopeCalls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } }));
  await session.launchAgent(() => resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } }), () => {});
  session.complete("Готово");
  await session.close();
  assert.equal(scopeCalls, 1);
  assert.equal(hostCalls, 1);
  assert.deepEqual(value.waits, []);
  await resources.assertReleased(value.workspace.id);
});

test("общий срок ограничивает зависшую очистку даже при большем вложенном тайм-ауте", { timeout: 2_000 }, async (context) => {
  const value = await fixture(context);
  const resources = new AgentResources({ ...value.cleanupOptions, registry: value.registry, command: value.command,
    clock: undefined, cleanupRetryTimeoutMs: 40, cleanupTimeoutMs: 1_000,
    async cleanProcesses() { await new Promise(() => {}); },
  });
  const agent = await resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  await assert.rejects(resources.release(agent.id, value.paseo, "archive"), /Истёк/u);
  assert.equal((await value.registry.list())[0].agentId, agent.id);
  await assert.rejects(resources.assertReleased(value.workspace.id), /Истёк/u);
});

test("исчерпание срока владельца не запускает новое ожидание MCP в finally сессии", { timeout: 2_000 }, async (context) => {
  const { createManagedAgentSession } = await import("../server/managed-agent-session.ts");
  const value = await fixture(context);
  const resources = new AgentResources({ ...value.cleanupOptions, registry: value.registry, command: value.command,
    clock: undefined, cleanupRetryTimeoutMs: 40, cleanupTimeoutMs: 500,
    async cleanProcesses() { await new Promise(() => {}); },
  });
  let closeCalls = 0;
  const resource = { async close() { closeCalls++; await new Promise(() => {}); } };
  const session = createManagedAgentSession({ signal: new AbortController().signal,
    host: resource, cleanupTimeoutMs: 500, updateNotificationLabel: async () => {}, agentDrainTimeoutMs: 10,
    logContext: "исчерпанный срок", logger: { warn() {} },
    releaseAgent: (agent, mode, closer) => resources.release(agent.id, value.paseo, mode, closer),
  });
  await session.openScope(() => resource);
  await session.launchAgent(() => resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } }), () => {});
  session.complete("Готово");
  await assert.rejects(session.close(), /Истёк/u);
  assert.equal(closeCalls, 0);
});

test("ошибка итоговой проверки сохраняет исходную ошибку этапа вместе с причиной очистки", async (context) => {
  const value = await fixture(context);
  const stageFailure = new Error("Ошибка проверки результата задачи");
  await assert.rejects(value.resources.runStage(value.workspace.id, value.paseo, async () => {
    const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
    value.setArchiveFailure(true);
    await value.resources.release(agent.id, value.paseo, "archive").catch(() => {});
    throw stageFailure;
  }), (error) => {
    assert.match(error.message, /Сбой демона/u);
    assert.ok(error.errors.includes(stageFailure));
    return true;
  });
});

test("сохраняет ID до создания в демоне и удаляет запись после полной очистки", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  const records = await value.registry.list();
  assert.equal(records[0].agentId, agent.id);
  await assert.rejects(value.resources.recover(value.paseo, value.workspace.id), /ресурсы предыдущих/iu);
  await value.resources.release(agent.id, value.paseo, "archive");
  assert.deepEqual(value.archived, [agent.id]);
  assert.deepEqual(value.cleaned, [[agent.id]]);
  assert.deepEqual(await value.registry.list(), []);
  assert.ok(value.snapshots.get(agent.id).archivedAt);
  assert.equal((await stat(join(value.home, "plugin-data", "paseo-openspec-orchestrator", "agent-resources.json"))).mode & 0o777, 0o600);
});

test("после устойчивой ошибки архивации очищает процессы и сохраняет запись для ручного повтора", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  value.setArchiveFailure(true);
  await assert.rejects(value.resources.release(agent.id, value.paseo, "archive"), /Сбой демона/u);
  assert.deepEqual(new Set(value.cleaned.flat()), new Set([agent.id]));
  assert.deepEqual(value.waits.slice(0, 4), [1_000, 2_000, 4_000, 5_000]);
  assert.equal(value.waits.reduce((sum, ms) => sum + ms, 0), 60_000);
  await assert.rejects(value.resources.assertReleased(value.workspace.id), /не освобождены/iu);
  value.setArchiveFailure(false);
  await value.resources.recover(value.paseo, value.workspace.id);
  assert.deepEqual(await value.registry.list(), []);
});

test("повторяет неудавшуюся очистку процессов после архивации", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  value.setProcessFailure(true);
  await assert.rejects(value.resources.release(agent.id, value.paseo, "archive"));
  assert.ok(value.snapshots.get(agent.id).archivedAt);
  assert.equal((await value.registry.list()).length, 1);
  value.setProcessFailure(false);
  await value.resources.recover(value.paseo, value.workspace.id);
  assert.deepEqual(await value.registry.list(), []);
});

test("при новом запуске восстанавливает очистку из отдельного реестра", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  await value.registry.beginRelease(agent.id, "archive");
  const recoveredRegistry = new AgentResourceRegistry(value.home);
  const restarted = new AgentResources({ ...value.cleanupOptions, command: value.command, registry: recoveredRegistry, cleanProcesses: value.cleanProcesses });
  await restarted.initialize(value.paseo);
  assert.deepEqual(value.archived, [agent.id]);
  assert.deepEqual(await recoveredRegistry.list(), []);
});

test("после аварии сохраняет незавершённую сессию для ручного продолжения", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  const restarted = new AgentResources({ ...value.cleanupOptions, command: value.command, registry: new AgentResourceRegistry(value.home), cleanProcesses: value.cleanProcesses });
  await restarted.initialize(value.paseo);
  assert.equal(value.snapshots.get(agent.id).archivedAt, null);
  assert.deepEqual(value.archived, []);
  assert.deepEqual(value.stopped, [agent.id]);
  assert.deepEqual(value.cleaned, [[agent.id]]);
  assert.equal(value.snapshots.get(agent.id).labels["openspec-preserved"], "true");
});

test("ручное продолжение и его новые потомки не попадают в повторную очистку", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  value.snapshots.set("child", { id: "child", labels: { "parent-agent-id": agent.id }, status: "running", archivedAt: null });
  await value.resources.release(agent.id, value.paseo, "preserve");
  assert.deepEqual(new Set(value.stopped), new Set([agent.id, "child"]));
  value.snapshots.get(agent.id).status = "running";
  value.snapshots.get("child").status = "running";
  value.snapshots.set("manual-child", { id: "manual-child", labels: { "parent-agent-id": "child" }, status: "running", archivedAt: null });
  const cleaned = value.cleaned.length;
  const restarted = new AgentResources({ ...value.cleanupOptions, registry: new AgentResourceRegistry(value.home), command: value.command, cleanProcesses: value.cleanProcesses });
  await restarted.initialize(value.paseo);
  await restarted.onAgentCreated({ id: "manual-child", parentAgentId: "child" }, value.paseo);
  await restarted.recover(value.paseo, value.workspace.id);
  await restarted.assertReleased(value.workspace.id);
  const next = await restarted.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  assert.equal(value.cleaned.length, cleaned);
  assert.equal(value.snapshots.get(agent.id).status, "running");
  assert.equal(value.snapshots.get("manual-child").status, "running");
  await restarted.release(next.id, value.paseo, "archive");
  assert.deepEqual(value.archived, [next.id]);
});

test("ошибка остановки закрывает MCP и оставляет режим сохранения для Retry", async (context) => {
  const value = await fixture(context);
  let stopFails = true;
  const resources = new AgentResources({ ...value.cleanupOptions, registry: value.registry, cleanProcesses: value.cleanProcesses,
    command: async (...args) => {
      if (stopFails && args[1][1] === "stop") throw new Error("Демон не принял остановку");
      return value.command(...args);
    },
  });
  const agent = await resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  let closed = 0;
  await assert.rejects(resources.release(agent.id, value.paseo, "preserve", async () => { closed++; }));
  assert.equal(closed, 1);
  assert.deepEqual(new Set(value.cleaned.flat()), new Set([agent.id]));
  assert.equal((await value.registry.list())[0].release, "preserve");
  assert.equal(value.snapshots.get(agent.id).labels["openspec-preserved"], undefined);
  stopFails = false;
  // Даже ошибочный повторный запрос не меняет уже сохранённый исход.
  await resources.release(agent.id, value.paseo, "archive");
  assert.deepEqual(value.archived, []);
  assert.deepEqual(await value.registry.list(), []);
});

test("сбой метки передачи управления сохраняет запись до успешного повторения", async (context) => {
  const value = await fixture(context);
  let labelFails = true;
  const resources = new AgentResources({ ...value.cleanupOptions, registry: value.registry, cleanProcesses: value.cleanProcesses,
    command: async (...args) => {
      if (labelFails && args[1][1] === "update") throw new Error("Метка не сохранена");
      return value.command(...args);
    },
  });
  const agent = await resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  await assert.rejects(resources.release(agent.id, value.paseo, "preserve"));
  assert.equal((await value.registry.list())[0].release, "preserve");
  labelFails = false;
  await resources.recover(value.paseo, value.workspace.id);
  assert.deepEqual(await value.registry.list(), []);
  assert.deepEqual(value.archived, []);
});

test("сбой удаления реестра после передачи управления не останавливает ручное продолжение", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  const removal = context.mock.method(value.registry, "removeRoot", async () => { throw new Error("Запись реестра прервана"); });
  await assert.rejects(value.resources.release(agent.id, value.paseo, "preserve"));
  assert.equal(value.snapshots.get(agent.id).labels["openspec-preserved"], "true");
  assert.equal((await value.registry.list()).length, 1);
  value.snapshots.get(agent.id).status = "running";
  value.snapshots.set("manual-child", { id: "manual-child", labels: { "parent-agent-id": agent.id }, status: "running", archivedAt: null });
  await value.resources.onAgentCreated({ id: "manual-child", parentAgentId: agent.id }, value.paseo);
  assert.equal((await value.registry.list()).length, 1);
  let closed = false;
  const unavailable = { agents: {
    async list() { throw new Error("Демон недоступен"); },
    ref() { return { async refresh() { throw new Error("Демон недоступен"); } }; },
  } };
  await assert.rejects(value.resources.release(agent.id, unavailable, "preserve", async () => { closed = true; }));
  assert.equal(closed, true);
  assert.deepEqual(value.cleaned, [[agent.id]]);
  removal.mock.restore();
  const restarted = new AgentResources({ ...value.cleanupOptions, registry: new AgentResourceRegistry(value.home), command: value.command, cleanProcesses: value.cleanProcesses });
  await restarted.initialize(value.paseo);
  assert.deepEqual(value.stopped, [agent.id]);
  assert.deepEqual(value.cleaned, [[agent.id]]);
  assert.deepEqual(value.archived, []);
  assert.equal(value.snapshots.get(agent.id).status, "running");
  assert.equal(value.snapshots.get("manual-child").status, "running");
  await restarted.assertReleased(value.workspace.id);
});

test("миграция версии 1 сохраняет открытые сессии и очищает архивные деревья", async (context) => {
  const value = await fixture(context);
  const active = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  const records = [{ agentId: active.id, rootAgentId: active.id, workspaceId: value.workspace.id },
    { agentId: "archived", rootAgentId: "archived", workspaceId: value.workspace.id }];
  value.snapshots.set("archived", { id: "archived", labels: {}, status: "idle", archivedAt: "2026-10-14" });
  const path = join(value.home, "plugin-data", "paseo-openspec-orchestrator", "agent-resources.json");
  await writeFile(path, JSON.stringify({ version: 1, resources: records }));
  const registry = new AgentResourceRegistry(value.home);
  assert.equal((await registry.list()).length, 2);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
  const restarted = new AgentResources({ ...value.cleanupOptions, registry, command: value.command, cleanProcesses: value.cleanProcesses });
  await restarted.initialize(value.paseo);
  assert.equal(value.snapshots.get(active.id).archivedAt, null);
  assert.deepEqual(value.archived, []);
  assert.ok(value.cleaned.some((ids) => ids.includes("archived")));
  assert.deepEqual(await registry.list(), []);
});

test("поздний потомок без hook останавливается до передачи управления", async (context) => {
  const value = await fixture(context);
  let inserted = false;
  const resources = new AgentResources({ ...value.cleanupOptions, registry: value.registry, command: value.command,
    cleanProcesses: async (ids) => {
      await value.cleanProcesses(ids);
      if (inserted) return;
      inserted = true;
      value.snapshots.set("late", { id: "late", labels: { "parent-agent-id": ids[0] }, status: "running", archivedAt: null });
    },
  });
  const agent = await resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  await resources.release(agent.id, value.paseo, "preserve");
  assert.deepEqual(new Set(value.stopped), new Set([agent.id, "late"]));
  assert.deepEqual(value.archived, []);
  assert.ok(value.cleaned.some((ids) => ids.includes("late")));
  assert.deepEqual(await value.registry.list(), []);
});

test("ошибка записи намерения не архивирует агента и оставляет данные для повторения", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  const original = value.registry.beginRelease.bind(value.registry);
  const mocked = context.mock.method(value.registry, "beginRelease", async () => { throw new Error("Диск недоступен"); });
  let closed = false;
  await assert.rejects(value.resources.release(agent.id, value.paseo, "archive", async () => { closed = true; }), /Диск/u);
  assert.equal(closed, true);
  assert.deepEqual(value.archived, []);
  assert.equal((await value.registry.list())[0].release, "managed");
  mocked.mock.restore();
  await original(agent.id, "preserve");
  await value.resources.recover(value.paseo, value.workspace.id);
  assert.deepEqual(value.archived, []);
});

test("очищает дочерних агентов по связи с родителем, сохраняя ручные сессии", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  value.snapshots.set("child", { id: "child", labels: { "parent-agent-id": agent.id }, archivedAt: null });
  value.snapshots.set("grandchild", { id: "grandchild", labels: { "parent-agent-id": "child" }, archivedAt: null });
  value.snapshots.set("manual", { id: "manual", labels: {}, archivedAt: null });
  await value.resources.release(agent.id, value.paseo, "archive");
  assert.deepEqual(new Set(value.archived), new Set([agent.id, "child", "grandchild"]));
  assert.equal(value.snapshots.get("manual").archivedAt, null);
  assert.deepEqual(new Set(value.cleaned[0]), new Set([agent.id, "child", "grandchild"]));
});

test("позднее событие создания восстанавливает принадлежность по меткам демона", async (context) => {
  const value = await fixture(context);
  await value.resources.initialize(value.paseo);
  value.snapshots.set("late", { id: "late", workspaceId: "workspace-1", archivedAt: null,
    labels: { "openspec-orchestrator": "paseo-openspec-orchestrator", "openspec-root-agent-id": "late" } });
  await value.resources.onAgentCreated({ id: "late", parentAgentId: null }, value.paseo);
  await value.resources.recover(value.paseo, value.workspace.id);
  assert.equal(value.snapshots.get("late").archivedAt, null);
  assert.equal(value.snapshots.get("late").labels["openspec-preserved"], "true");
  assert.deepEqual(await value.registry.list(), []);
});

test("событие позднего дочернего агента находит уже архивированного родителя", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  await value.resources.release(agent.id, value.paseo, "archive");
  value.snapshots.set("late-child", { id: "late-child", labels: { "parent-agent-id": agent.id }, archivedAt: null });
  await value.resources.onAgentCreated({ id: "late-child", parentAgentId: agent.id }, value.paseo);
  await value.resources.recover(value.paseo, value.workspace.id);
  assert.ok(value.snapshots.get("late-child").archivedAt);
  assert.deepEqual(await value.registry.list(), []);
});

test("последовательные этапы не накапливают записи и активные сессии", async (context) => {
  const value = await fixture(context);
  for (let index = 0; index < 12; index++) {
    const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
    await Promise.all([value.resources.release(agent.id, value.paseo, "archive"), value.resources.release(agent.id, value.paseo, "archive")]);
    assert.deepEqual(await value.registry.list(), []);
  }
  assert.equal(value.archived.length, 12);
  assert.equal([...value.snapshots.values()].filter((agent) => !agent.archivedAt).length, 0);
});

test("повреждённый реестр блокирует создание агента", async (context) => {
  const value = await fixture(context);
  await value.registry.add({ agentId: "previous", rootAgentId: "previous", workspaceId: value.workspace.id });
  const path = join(value.home, "plugin-data", "paseo-openspec-orchestrator", "agent-resources.json");
  await writeFile(path, '{"version":999,"resources":[]}');
  const restarted = new AgentResources({ ...value.cleanupOptions, command: value.command, registry: new AgentResourceRegistry(value.home), cleanProcesses: value.cleanProcesses });
  await assert.rejects(restarted.create(value.workspace, value.paseo, { config: { provider: "codex/model" } }), /прочитать реестр/iu);
  assert.equal(value.snapshots.size, 0);
  assert.match(await readFile(path, "utf8"), /999/u);
});

test("ошибка создания очищает зарегистрированный ID, даже если ответа агента нет", async (context) => {
  const value = await fixture(context);
  const failing = { ...value.workspace, agents: { async create() { throw new Error("Ошибка создания"); } } };
  await assert.rejects(value.resources.create(failing, value.paseo, { config: { provider: "codex/model" } }), /Ошибка создания/u);
  assert.equal(value.cleaned.length, 1);
  assert.deepEqual(await value.registry.list(), []);
});

test("ребёнок, созданный во время очистки процессов, проходит отдельный полный проход", async (context) => {
  const value = await fixture(context);
  let inserted = false;
  const resources = new AgentResources({ ...value.cleanupOptions, command: value.command, registry: value.registry, cleanProcesses: async (ids) => {
    await value.cleanProcesses(ids);
    if (inserted) return;
    inserted = true;
    value.snapshots.set("racing-child", { id: "racing-child", labels: { "parent-agent-id": ids[0] }, archivedAt: null });
    await resources.onAgentCreated({ id: "racing-child", parentAgentId: ids[0] }, value.paseo);
  } });
  const agent = await resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  await resources.release(agent.id, value.paseo, "archive");
  await resources.recover(value.paseo, value.workspace.id);
  assert.ok(value.snapshots.get("racing-child").archivedAt);
  assert.ok(value.cleaned.some((ids) => ids.includes("racing-child")));
  assert.deepEqual(await value.registry.list(), []);
});

test("после рестарта находит позднего ребёнка архивированного родителя без hook", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  await value.resources.release(agent.id, value.paseo, "archive");
  value.snapshots.set("missed-child", { id: "missed-child", labels: { "parent-agent-id": agent.id }, archivedAt: null });
  value.snapshots.set("missed-grandchild", { id: "missed-grandchild", labels: { "parent-agent-id": "missed-child" }, archivedAt: null });
  const restarted = new AgentResources({ ...value.cleanupOptions, command: value.command, registry: new AgentResourceRegistry(value.home), cleanProcesses: value.cleanProcesses });
  await restarted.initialize(value.paseo);
  assert.ok(value.snapshots.get("missed-child").archivedAt);
  assert.ok(value.snapshots.get("missed-grandchild").archivedAt);
});

test("атомарное удаление сохраняет записи, добавленные после проверки набора", async (context) => {
  const value = await fixture(context);
  await value.registry.add({ agentId: "root", rootAgentId: "root", workspaceId: value.workspace.id });
  const checked = (await value.registry.list()).map(({ agentId }) => agentId);
  await value.registry.add({ agentId: "child", rootAgentId: "root", workspaceId: value.workspace.id });
  assert.equal(await value.registry.removeRoot("root", checked), false);
  assert.equal((await value.registry.list()).length, 2);
});

test("одновременное создание в одной рабочей области запускает только одного агента", async (context) => {
  const value = await fixture(context);
  const first = value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  await assert.rejects(value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } }), /уже создаётся/u);
  const agent = await first;
  assert.equal(value.snapshots.size, 1);
  await value.resources.release(agent.id, value.paseo, "archive");
});

test("восстановление очищает известные процессы даже при недоступном API демона", async (context) => {
  const value = await fixture(context);
  await value.registry.add({ agentId: "unavailable", rootAgentId: "unavailable", workspaceId: value.workspace.id });
  const unavailable = { agents: {
    async list() { throw new Error("API недоступен"); },
    ref() { return { async refresh() { throw new Error("API недоступен"); } }; },
  } };
  await assert.rejects(value.resources.initialize(unavailable));
  assert.deepEqual(new Set(value.cleaned.flat()), new Set(["unavailable"]));
  assert.equal((await value.registry.list()).length, 1);
});

test("сбой закрытия MCP сохраняет владельца и повторяется до нового агента", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  let attempts = 0;
  let failClose = true;
  await assert.rejects(value.resources.release(agent.id, value.paseo, "archive", async () => {
    attempts++;
    if (failClose) throw new Error("MCP ещё открыт");
  }));
  await assert.rejects(value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } }));
  assert.equal(value.snapshots.size, 1);
  const failedAttempts = attempts;
  assert.ok(failedAttempts > 1);
  failClose = false;
  const next = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  assert.equal(attempts, failedAttempts + 1);
  await value.resources.release(next.id, value.paseo, "archive");
});

test("штатное закрытие останавливает и сохраняет активные сессии и запрещает новые", async (context) => {
  const value = await fixture(context);
  const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
  await value.resources.close();
  assert.equal(value.snapshots.get(agent.id).archivedAt, null);
  assert.deepEqual(value.stopped, [agent.id]);
  assert.deepEqual(await value.registry.list(), []);
  await assert.rejects(value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } }), /останавливается/u);
});

test("сброс workflow и выгрузка движка сохраняют сессию и закрывают MCP", async (context) => {
  const { createManagedAgentSession } = await import("../server/managed-agent-session.ts");
  const { OpenSpecOrchestratorEngine } = await import("../server/openspec-orchestrator-engine.ts");
  const { OrchestratorLedger } = await import("../server/orchestrator-ledger.ts");
  for (const action of ["clear", "dispose"]) {
    await context.test(action === "clear" ? "Сброс состояния" : "Выгрузка движка", async (subcontext) => {
      const value = await fixture(subcontext);
      const ledger = new OrchestratorLedger({ paseoHome: value.home });
      await ledger.open(value.workspace.id);
      const engine = new OpenSpecOrchestratorEngine(ledger);
      subcontext.after(async () => { await engine.dispose(); await ledger.close(); });
      let started;
      const ready = new Promise((resolve) => { started = resolve; });
      const closed = [];
      let agentId;
      engine.initialize(value.workspace.id, {
        workspaceDisplay: { projectName: null, workspaceName: null },
        refreshWorkspaceDisplay: async () => ({ projectName: null, workspaceName: null }),
        workflow: { startStepId: "agent", steps: [{ id: "agent", label: "Долгий этап", run: (step) =>
          value.resources.runStage(value.workspace.id, value.paseo, async () => {
            const session = createManagedAgentSession({ signal: step.signal,
              host: { async close() { closed.push("host"); } },
              releaseAgent: (agent, mode, closer) => value.resources.release(agent.id, value.paseo, mode, closer),
              updateNotificationLabel: async () => {}, agentDrainTimeoutMs: 10, logContext: "тест", logger: { warn() {} },
            });
            await session.openScope(() => ({ async close() { closed.push("scope"); } }));
            try {
              await session.launchAgent(() => value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } }), (id) => {
                agentId = id;
                step.updateActionLinks([{ kind: "agent", agentId: id, label: "Агент" }]);
              });
              started();
              await session.waitForCompletion();
              return { kind: "complete", summary: "Готово" };
            } finally { await session.close(); }
          }),
        }] },
      });
      engine.command(value.workspace.id, "start");
      await ready;
      if (action === "clear") engine.command(value.workspace.id, "clear");
      await engine.dispose();
      assert.equal(value.snapshots.get(agentId).archivedAt, null);
      assert.deepEqual(value.stopped, [agentId]);
      assert.deepEqual(closed, ["scope", "host"]);
      assert.deepEqual(await value.registry.list(), []);
      if (action === "dispose") {
        assert.equal(ledger.get(value.workspace.id).history.at(-1).links[0].agentId, agentId);
      }
    });
  }
});

test("Retry после ошибки очистки сохраняет checkpoint результата и не повторяет агентную работу", async (context) => {
  context.mock.method(console, "error", () => {});
  const { OpenSpecOrchestratorEngine } = await import("../server/openspec-orchestrator-engine.ts");
  const { OrchestratorLedger } = await import("../server/orchestrator-ledger.ts");
  const value = await fixture(context);
  const ledger = new OrchestratorLedger({ paseoHome: value.home });
  await ledger.open(value.workspace.id);
  const engine = new OpenSpecOrchestratorEngine(ledger);
  context.after(async () => { await engine.dispose(); await ledger.close(); });
  const pending = { artifactId: "proposal", schemaName: "spec-driven", baselineCommit: "a".repeat(40) };
  let work = 0;
  let next = 0;
  engine.initialize(value.workspace.id, {
    workspaceDisplay: { projectName: null, workspaceName: null },
    refreshWorkspaceDisplay: async () => ({ projectName: null, workspaceName: null }),
    workflow: { startStepId: "agent", steps: [
      { id: "agent", label: "Проверяю результат", run: (step) => value.resources.runStage(value.workspace.id, value.paseo, async () => {
        if (!step.state.pendingArtifactSession) {
          work++;
          const agent = await value.resources.create(value.workspace, value.paseo, { config: { provider: "codex/model" } });
          await step.checkpointState({ ...step.state, pendingArtifactSession: pending });
          // Доменный шаг мог преобразовать ошибку закрытия в свой halt; общий gate её сохраняет.
          await value.resources.release(agent.id, value.paseo, "archive").catch(() => {});
        }
        return { kind: "continue", next: "next", summary: "Проверенный результат сохранён" };
      }) },
      { id: "next", label: "Следующий этап", async run() { next++; return { kind: "complete", summary: "Готово" }; } },
    ] },
  });
  const waitForStatus = async (status) => {
    const deadline = Date.now() + 3_000;
    while (ledger.get(value.workspace.id).lifecycle.status !== status) {
      assert.ok(Date.now() < deadline, `Не дождались состояния ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  value.setProcessFailure(true);
  engine.command(value.workspace.id, "start");
  await waitForStatus("failed");
  assert.match(ledger.get(value.workspace.id).lifecycle.message, /не освобождены/u);
  assert.match(ledger.get(value.workspace.id).lifecycle.message, /Процесс не завершился/u);
  assert.deepEqual(ledger.getWorkflowCheckpoint(value.workspace.id).state.pendingArtifactSession, pending);
  assert.equal(next, 0);
  value.setProcessFailure(false);
  engine.command(value.workspace.id, "retry");
  await waitForStatus("completed");
  assert.equal(work, 1);
  assert.equal(next, 1);
  assert.deepEqual(await value.registry.list(), []);
});
