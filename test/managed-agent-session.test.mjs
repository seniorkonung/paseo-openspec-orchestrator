import assert from "node:assert/strict";
import test from "node:test";
import { createManagedAgentSession } from "../server/managed-agent-session.ts";

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
      async waitForFinish() {
        throw Object.assign(new Error("drain"), { code: "DRAIN" });
      },
    }),
    () => undefined,
  );

  await session.drainAgent();
  await session.close();

  assert.deepEqual(operations, [
    "drain-agent",
    "ntfy",
    "disable-notifications",
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
    async () => ({ id: "agent-1", waitForFinish: async () => undefined }),
    () => undefined,
  );

  await session.close();

  assert.deepEqual(events, ["scope", "host"]);
});
