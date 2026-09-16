import assert from "node:assert/strict";
import test from "node:test";
import {
  ORCHESTRATOR_LIMITS,
  agentLinkSchema,
  controlCommandSchema,
  currentActionSchema,
  lifecycleSchema,
  orchestratorSnapshotSchema,
} from "../shared/orchestrator.ts";

const startedAt = "2026-09-16T10:00:00.000Z";

function snapshot(overrides = {}) {
  return {
    workspaceId: "workspace-1",
    revision: "1",
    change: null,
    lifecycle: { status: "idle", availableCommand: "start" },
    currentAction: null,
    history: [],
    persistence: { status: "ready" },
    ...overrides,
  };
}

test("контракт принимает все допустимые lifecycle-состояния", () => {
  const variants = [
    { status: "idle", availableCommand: "start" },
    { status: "starting", availableCommand: null },
    { status: "running", availableCommand: "pause" },
    { status: "pausing", availableCommand: null },
    { status: "paused", availableCommand: "resume" },
    { status: "completed", availableCommand: "start" },
    { status: "failed", availableCommand: "retry", message: "Сбой" },
  ];

  for (const lifecycle of variants) {
    assert.deepEqual(lifecycleSchema.parse(lifecycle), lifecycle);
  }
});

test("контракт отклоняет команду, несовместимую с lifecycle", () => {
  assert.equal(
    lifecycleSchema.safeParse({ status: "paused", availableCommand: "start" }).success,
    false,
  );
});

test("контракт принимает destructive-команду полной очистки", () => {
  assert.equal(controlCommandSchema.parse("clear"), "clear");
});

test("контракт отклоняет текущее действие в неактивном состоянии", () => {
  const result = orchestratorSnapshotSchema.safeParse(
    snapshot({
      currentAction: { id: "a", text: "Работаю", startedAt, links: [] },
    }),
  );

  assert.equal(result.success, false);
});

test("контракт ограничивает текст и число agent-ссылок", () => {
  assert.equal(
    currentActionSchema.safeParse({
      id: "a",
      text: "x".repeat(ORCHESTRATOR_LIMITS.actionText + 1),
      startedAt,
      links: [],
    }).success,
    false,
  );

  const links = Array.from({ length: ORCHESTRATOR_LIMITS.agentLinks + 1 }, (_, index) => ({
    kind: "agent",
    agentId: `agent-${index}`,
    label: `Агент ${index}`,
  }));
  assert.equal(
    currentActionSchema.safeParse({ id: "a", text: "Работаю", startedAt, links }).success,
    false,
  );

  const duplicateLink = { kind: "agent", agentId: "agent-1", label: "Исполнитель" };
  assert.equal(
    currentActionSchema.safeParse({
      id: "a",
      text: "Работаю",
      startedAt,
      links: [duplicateLink, duplicateLink],
    }).success,
    false,
  );
});

test("agent-ссылка имеет закрытую типизированную форму", () => {
  assert.equal(
    agentLinkSchema.safeParse({
      kind: "agent",
      agentId: "agent-1",
      label: "Исполнитель",
      href: "javascript:alert(1)",
    }).success,
    false,
  );
});

test("контракт требует уникальную хронологическую историю", () => {
  const first = {
    id: "same",
    text: "Первое",
    startedAt: "2026-09-16T10:00:02.000Z",
    finishedAt: "2026-09-16T10:00:03.000Z",
    outcome: "succeeded",
    links: [],
  };
  const second = {
    ...first,
    text: "Второе",
    startedAt: "2026-09-16T10:00:01.000Z",
  };

  assert.equal(
    orchestratorSnapshotSchema.safeParse(snapshot({ history: [first, second] })).success,
    false,
  );
});
