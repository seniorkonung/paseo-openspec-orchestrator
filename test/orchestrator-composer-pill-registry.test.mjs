import assert from "node:assert/strict";
import test from "node:test";
import { OrchestratorComposerPillRegistry } from "../client/orchestrator-composer-pill-registry.ts";

function createHarness() {
  const created = [];
  const removed = [];
  const registry = new OrchestratorComposerPillRegistry(({ agentId, workspaceId }) => {
    created.push({ agentId, workspaceId });
    return {
      remove() {
        removed.push(agentId);
      },
    };
  });
  return { created, registry, removed };
}

test("показывает один шильдик для каждого агента доступной рабочей области", () => {
  const { created, registry } = createHarness();
  registry.upsertAgent({ agentId: "agent-1", workspaceId: "workspace-1", archived: false });
  registry.upsertAgent({ agentId: "agent-2", workspaceId: "workspace-1", archived: false });

  assert.deepEqual(created, []);
  registry.setWorkspaceAvailability("workspace-1", true);
  registry.setWorkspaceAvailability("workspace-1", true);

  assert.deepEqual(created, [
    { agentId: "agent-1", workspaceId: "workspace-1" },
    { agentId: "agent-2", workspaceId: "workspace-1" },
  ]);
});

test("сигнализирует о проверке при появлении каждой новой агентской сессии", () => {
  const { registry } = createHarness();

  assert.equal(
    registry.upsertAgent({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      archived: false,
    }),
    "workspace-1",
  );
  assert.equal(
    registry.upsertAgent({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      archived: false,
    }),
    null,
  );
  assert.equal(
    registry.upsertAgent({
      agentId: "agent-2",
      workspaceId: "workspace-1",
      archived: false,
    }),
    "workspace-1",
  );
});

test("скрывает и восстанавливает шильдики при изменении доступности OpenSpec", () => {
  const { created, registry, removed } = createHarness();
  registry.upsertAgent({ agentId: "agent-1", workspaceId: "workspace-1", archived: false });
  registry.setWorkspaceAvailability("workspace-1", true);
  registry.setWorkspaceAvailability("workspace-1", false);

  assert.deepEqual(removed, ["agent-1"]);
  registry.setWorkspaceAvailability("workspace-1", true);
  assert.equal(created.length, 2);
});

test("удаляет шильдик при архивировании или переносе агента", () => {
  const { created, registry, removed } = createHarness();
  registry.upsertAgent({ agentId: "agent-1", workspaceId: "workspace-1", archived: false });
  registry.setWorkspaceAvailability("workspace-1", true);
  registry.upsertAgent({ agentId: "agent-1", workspaceId: "workspace-2", archived: false });
  registry.setWorkspaceAvailability("workspace-2", true);
  registry.upsertAgent({ agentId: "agent-1", workspaceId: "workspace-2", archived: true });

  assert.deepEqual(created, [
    { agentId: "agent-1", workspaceId: "workspace-1" },
    { agentId: "agent-1", workspaceId: "workspace-2" },
  ]);
  assert.deepEqual(removed, ["agent-1", "agent-1"]);
});

test("очищает все регистрации без повторного удаления", () => {
  const { registry, removed } = createHarness();
  registry.upsertAgent({ agentId: "agent-1", workspaceId: "workspace-1", archived: false });
  registry.upsertAgent({ agentId: "agent-2", workspaceId: "workspace-1", archived: false });
  registry.setWorkspaceAvailability("workspace-1", true);

  registry.clear();
  registry.clear();

  assert.deepEqual(removed, ["agent-1", "agent-2"]);
});
