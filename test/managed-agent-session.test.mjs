import assert from "node:assert/strict";
import test from "node:test";
import { createManagedAgentSession as createSession } from "../server/managed-agent-session.ts";

function createManagedAgentSession(options) {
  return createSession({
    async releaseAgent(agent, mode) {
      if (mode === "archive") await agent.archive();
      else await agent.stop?.();
    },
    ...options,
  });
}

test("управляет готовностью, завершением, ntfy и ресурсами одной agent-сессии", async () => {
  const events = [];
  const controller = new AbortController();
  const session = createManagedAgentSession({
    signal: controller.signal,
    host: { close: async () => events.push("host:close") },
    updateNotificationLabel: async (agentId, enabled) =>
      events.push(`ntfy:${agentId}:${enabled}`),
    agentDrainTimeoutMs: 123,
    logContext: "тест",
    logger: { warn() {} },
  });
  await session.openScope(() => ({
    close: async () => events.push("scope:close"),
  }));

  const agent = await session.launchAgent(
    async () => ({
      id: "agent-1",
      async archive() { events.push("agent:archive"); },
      async waitForFinish(timeoutMs) {
        events.push(`drain:${timeoutMs}`);
      },
    }),
    (agentId) => events.push(`created:${agentId}`),
  );

  assert.equal(await session.waitForAgent(controller.signal), agent);
  await session.disableNotifications(controller.signal);
  await session.restoreNotifications(controller.signal);
  session.complete("готово");
  assert.equal(await session.waitForCompletion(), "готово");
  await session.drainAgent();
  await session.close();
  await session.close();

  assert.deepEqual(events, [
    "created:agent-1",
    "ntfy:agent-1:false",
    "ntfy:agent-1:true",
    "drain:123",
    "ntfy:agent-1:false",
    "agent:archive",
    "scope:close",
    "host:close",
  ]);
});

test("отмена отклоняет ожидание результата и закрывает host без агента", async () => {
  const events = [];
  const controller = new AbortController();
  const session = createManagedAgentSession({
    signal: controller.signal,
    host: { close: async () => events.push("host:close") },
    updateNotificationLabel: async () => undefined,
    agentDrainTimeoutMs: 123,
    logContext: "тест отмены",
    logger: { warn() {} },
  });

  controller.abort();

  await assert.rejects(session.waitForCompletion(), /Операция отменена/);
  await session.close();
  assert.deepEqual(events, ["host:close"]);
});

test("ошибка создания MCP scope сразу закрывает принадлежащий сессии host", async () => {
  const events = [];
  const session = createManagedAgentSession({
    signal: new AbortController().signal,
    host: { close: async () => events.push("host:close") },
    updateNotificationLabel: async () => undefined,
    agentDrainTimeoutMs: 123,
    logContext: "тест открытия scope",
    logger: { warn() {} },
  });

  await assert.rejects(
    session.openScope(() => {
      throw new Error("scope не создан");
    }),
    /scope не создан/,
  );
  assert.deepEqual(events, ["host:close"]);
});

test("cleanup остаётся best-effort после ошибок внешних ресурсов", async () => {
  const operations = [];
  const controller = new AbortController();
  const session = createManagedAgentSession({
    signal: controller.signal,
    host: {
      async close() {
        operations.push("host");
        throw Object.assign(new Error("host"), { code: "HOST" });
      },
    },
    async updateNotificationLabel() {
      operations.push("ntfy");
      throw Object.assign(new Error("ntfy"), { code: "NTFY" });
    },
    agentDrainTimeoutMs: 123,
    logContext: "тест ошибок cleanup",
    logger: {
      warn(_message, details) {
        operations.push(details.operation);
      },
    },
  });
  await session.openScope(() => ({
    async close() {
      operations.push("scope");
      throw Object.assign(new Error("scope"), { code: "SCOPE" });
    },
  }));
  await session.launchAgent(
    async () => ({
      id: "agent-1",
      async archive() { operations.push("archive"); },
      async waitForFinish() {
        throw Object.assign(new Error("drain"), { code: "DRAIN" });
      },
    }),
    () => undefined,
  );

  session.complete("готово");
  await session.drainAgent();
  await assert.rejects(session.close(), /освободить ресурсы/iu);

  assert.deepEqual(operations, [
    "drain-agent",
    "ntfy",
    "disable-notifications",
    "archive",
    "scope",
    "close-scope",
    "host",
    "close-host",
  ]);
});

test("ошибка logger не останавливает закрытие следующих ресурсов", async () => {
  const events = [];
  const session = createManagedAgentSession({
    signal: new AbortController().signal,
    host: { close: async () => events.push("host") },
    async updateNotificationLabel() {
      throw new Error("ntfy");
    },
    agentDrainTimeoutMs: 123,
    logContext: "тест logger",
    logger: {
      warn() {
        throw new Error("logger");
      },
    },
  });
  await session.openScope(() => ({
    close: async () => events.push("scope"),
  }));
  await session.launchAgent(
    async () => ({ id: "agent-1", waitForFinish: async () => undefined, archive: async () => {} }),
    () => undefined,
  );

  await session.close();

  assert.deepEqual(events, ["scope", "host"]);
});

test("одновременные close ожидают одну архивацию и полное закрытие ресурсов", async () => {
  let finishArchive;
  let archiveCalls = 0;
  let hostClosed = false;
  const session = createManagedAgentSession({
    signal: new AbortController().signal,
    host: { async close() { hostClosed = true; } },
    updateNotificationLabel: async () => {},
    agentDrainTimeoutMs: 10,
    logContext: "одновременное закрытие",
    logger: { warn() {} },
  });
  await session.launchAgent(async () => ({
    id: "agent-1", waitForFinish: async () => {},
    async archive() {
      archiveCalls++;
      await new Promise((resolve) => { finishArchive = resolve; });
    },
  }), () => {});
  session.complete("готово");
  const first = session.close();
  const second = session.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(archiveCalls, 1);
  assert.equal(hostClosed, false);
  finishArchive();
  await Promise.all([first, second]);
  assert.equal(hostClosed, true);
});

test("отмена во время создания останавливает поздно появившегося агента без архивации", async () => {
  const controller = new AbortController();
  let finishCreation;
  const events = [];
  const session = createManagedAgentSession({
    signal: controller.signal,
    host: { async close() { events.push("host"); } },
    updateNotificationLabel: async () => {},
    agentDrainTimeoutMs: 10,
    logContext: "позднее создание",
    logger: { warn() {} },
  });
  const launching = session.launchAgent(() => new Promise((resolve) => { finishCreation = resolve; }),
    () => events.push("published"));
  controller.abort();
  const rejected = assert.rejects(launching, /отменена/iu);
  const closing = session.close();
  finishCreation({ id: "late-agent", waitForFinish: async () => {}, async archive() { events.push("archive"); }, async stop() { events.push("stop"); } });
  await rejected;
  await closing;
  assert.deepEqual(events, ["stop", "host"]);
});

test("ошибка архивации сообщается после закрытия MCP и host", async () => {
  const events = [];
  const session = createManagedAgentSession({
    signal: new AbortController().signal,
    host: { async close() { events.push("host"); } },
    updateNotificationLabel: async () => {},
    agentDrainTimeoutMs: 10,
    logContext: "ошибка архивации",
    logger: { warn() {} },
  });
  await session.openScope(() => ({ async close() { events.push("scope"); } }));
  await session.launchAgent(async () => ({
    id: "agent-1", waitForFinish: async () => {},
    async archive() { throw new Error("архивация недоступна"); },
  }), () => {});
  session.complete("готово");
  await assert.rejects(session.close(), /очист|архивац/iu);
  assert.deepEqual(events, ["scope", "host"]);
});

function managedFixture(overrides = {}) {
  return createManagedAgentSession({
    signal: new AbortController().signal,
    host: { async close() {} },
    updateNotificationLabel: async () => {},
    agentDrainTimeoutMs: 10,
    logContext: "граничные случаи",
    logger: { warn() {} },
    ...overrides,
  });
}

test("поздний агент останавливается и после истечения срока ожидания создания", async () => {
  const controller = new AbortController();
  let finishCreation;
  let archived;
  const finished = new Promise((resolve) => { archived = resolve; });
  let hostClosed = false;
  const session = managedFixture({ signal: controller.signal, cleanupTimeoutMs: 10,
    host: { async close() { hostClosed = true; } } });
  const launching = session.launchAgent(() => new Promise((resolve) => { finishCreation = resolve; }),
    () => assert.fail("Отменённый агент не должен публиковаться"));
  controller.abort();
  await assert.rejects(launching, /отменена/iu);
  await assert.rejects(session.close(), /ресурсы/iu);
  assert.equal(hostClosed, true);
  finishCreation({ id: "late", async waitForFinish() {}, async archive() { assert.fail("Незавершённый агент не архивируется"); }, async stop() { archived(); } });
  await finished;
});

test("уже отменённый сигнал не запускает агента и отклоняет ожидание завершения", async () => {
  const session = managedFixture({ signal: AbortSignal.abort() });
  await assert.rejects(session.launchAgent(async () => assert.fail("Создание запрещено"), () => {}), /отменена/iu);
  await assert.rejects(session.waitForCompletion(), /отменена/iu);
  await session.close();
});

test("отмена прерывает ожидание финального ответа без архивации незавершённого этапа", async () => {
  const controller = new AbortController();
  let archived = false;
  const session = managedFixture({ signal: controller.signal });
  await session.launchAgent(async () => ({ id: "agent",
    async waitForFinish() { await new Promise(() => {}); },
    async archive() { archived = true; },
  }), () => {});
  const draining = session.drainAgent();
  controller.abort();
  await draining;
  await session.close();
  assert.equal(archived, false);
});

test("отмена после сохранённого результата не меняет успешный исход этапа", async () => {
  const controller = new AbortController();
  const modes = [];
  const session = managedFixture({ signal: controller.signal,
    async releaseAgent(_agent, mode) { modes.push(mode); },
  });
  await session.launchAgent(async () => ({ id: "agent", async waitForFinish() {}, async archive() {} }), () => {});
  session.complete("сохранено");
  controller.abort();
  await Promise.all([session.close(), session.close()]);
  assert.deepEqual(modes, ["archive"]);
});

test("поздний completion не превращает прерванную сессию в успешную", async () => {
  const modes = [];
  const session = managedFixture({ async releaseAgent(_agent, mode) { modes.push(mode); } });
  await session.launchAgent(async () => ({ id: "agent", async waitForFinish() {}, async archive() {} }), () => {});
  const closing = session.close();
  assert.throws(() => session.complete("слишком поздно"), /отменена/u);
  await closing;
  assert.deepEqual(modes, ["preserve"]);
});

test("владелец получает повторяемое закрытие MCP, успешные ресурсы повторно не закрываются", async () => {
  let localCloser;
  let failScope = true;
  let scopeCalls = 0;
  let hostCalls = 0;
  const session = managedFixture({
    host: { async close() { hostCalls++; } },
    async releaseAgent(agent, _mode, closeLocalResources) {
      await agent.archive();
      localCloser = closeLocalResources;
      await closeLocalResources();
    },
  });
  await session.openScope(() => ({ async close() {
    scopeCalls++;
    if (failScope) throw new Error("scope ещё открыт");
  } }));
  await session.launchAgent(async () => ({ id: "agent", async waitForFinish() {}, async archive() {} }), () => {});
  await assert.rejects(session.close());
  assert.equal(hostCalls, 1);
  failScope = false;
  await localCloser();
  assert.equal(hostCalls, 1);
  assert.equal(scopeCalls, 3);
});

test("сессия ожидает автоматическое восстановление владельца дольше отдельного тайм-аута", async () => {
  let closed = false;
  const session = managedFixture({ cleanupTimeoutMs: 5,
    async releaseAgent(_agent, _mode, closeLocalResources) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await closeLocalResources();
      closed = true;
    },
  });
  await session.launchAgent(async () => ({ id: "agent", async waitForFinish() {}, async archive() {} }), () => {});
  session.complete("Готово");
  await session.close();
  assert.equal(closed, true);
});
