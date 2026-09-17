import assert from "node:assert/strict";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  CHANGE_SELECTION_PROMPT,
  createChangeSelectionService,
} from "../server/change-selection.ts";
import { OpenSpecChangeError } from "../server/openspec-change.ts";

async function connectClient(url) {
  const client = new Client({ name: "change-selection-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

function firstText(result) {
  const content = result.content[0];
  assert.equal(content?.type, "text");
  return content.text;
}

function profile() {
  return {
    id: "profile-low-sandbox",
    name: "Low Sandbox",
    provider: "codex",
    model: "gpt-5.5",
    modeId: "sandbox",
    thinkingOptionId: "medium",
    featureValues: { fast: true },
  };
}

test("агент получает Low Sandbox, ntfy и единственный scoped set_change", async () => {
  const created = [];
  const labels = [];
  const persisted = [];
  const completionOrder = [];
  const toolResults = [];
  let toolFlow;
  const service = createChangeSelectionService({
    async createAgent(options) {
      created.push(options);
      const [{ url }] = Object.values(options.config.mcpServers);
      toolFlow = (async () => {
        const client = await connectClient(url);
        try {
          const tools = await client.listTools();
          assert.deepEqual(tools.tools.map(({ name }) => name), ["set_change"]);
          toolResults.push(
            await client.callTool({
              name: "set_change",
              arguments: { changeId: "missing-change" },
            }),
          );
          toolResults.push(
            await client.callTool({
              name: "set_change",
              arguments: { changeId: "selected-change" },
            }),
          );
        } finally {
          await client.close();
        }
      })();
      return {
        id: "agent-selection",
        waitForFinish: async () => {
          await toolFlow;
          return { status: "idle", lastMessage: null };
        },
      };
    },
    async verifyChange(_workspace, changeId) {
      if (changeId === "missing-change") {
        throw new OpenSpecChangeError("Change отсутствует");
      }
      return { id: changeId };
    },
    async updateNotificationLabel(agentId, enabled) {
      labels.push([agentId, enabled]);
      completionOrder.push(`ntfy=${enabled}`);
    },
    logger: { error() {}, warn() {} },
  });

  const links = [];
  const change = await service.select({
    workspaceDirectory: "/workspace/project",
    profile: profile(),
    signal: new AbortController().signal,
    onAgentCreated: (agentId) => links.push(agentId),
    onChangeSelected: async (selected) => {
      persisted.push(selected);
      completionOrder.push("persisted");
    },
  });

  assert.deepEqual(change, { id: "selected-change" });
  assert.equal(created.length, 1);
  assert.equal(created[0].config.provider, "codex/gpt-5.5");
  assert.equal(created[0].config.modeId, "sandbox");
  assert.equal(created[0].config.thinkingOptionId, "medium");
  assert.deepEqual(created[0].config.featureValues, { fast: true });
  assert.deepEqual(created[0].labels, { ntfy: "true" });
  assert.equal("autoArchive" in created[0], false);
  assert.equal(created[0].title, "Выбор OpenSpec change");
  assert.equal(created[0].prompt, CHANGE_SELECTION_PROMPT);
  assert.match(created[0].prompt, /mise exec --no-deps -- openspec list --json/);
  assert.match(
    created[0].prompt,
    /mise exec --no-deps -- openspec status --change <id> --json/,
  );
  assert.match(created[0].prompt, /Do not archive agents or workspaces/);
  assert.equal("cwd" in created[0], false);
  assert.deepEqual(links, ["agent-selection"]);
  assert.deepEqual(persisted, [{ id: "selected-change" }]);
  assert.deepEqual(labels, [["agent-selection", false]]);
  assert.deepEqual(completionOrder, ["ntfy=false", "persisted"]);
  assert.equal(toolResults[0].isError, true);
  assert.equal(firstText(toolResults[0]), "Change отсутствует");
  assert.equal(toolResults[1].isError, undefined);
  assert.deepEqual(toolResults[1].structuredContent, { changeId: "selected-change" });
});

test("после ошибки persistence восстанавливает ntfy и разрешает повторный вызов", async () => {
  const labels = [];
  const results = [];
  let persistenceAttempts = 0;
  let toolFlow;
  const service = createChangeSelectionService({
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      toolFlow = (async () => {
        const client = await connectClient(url);
        try {
          results.push(
            await client.callTool({
              name: "set_change",
              arguments: { changeId: "selected-change" },
            }),
          );
          results.push(
            await client.callTool({
              name: "set_change",
              arguments: { changeId: "selected-change" },
            }),
          );
        } finally {
          await client.close();
        }
      })();
      return {
        id: "agent-selection",
        waitForFinish: async () => {
          await toolFlow;
          return { status: "idle" };
        },
      };
    },
    verifyChange: async (_workspace, changeId) => ({ id: changeId }),
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });

  const change = await service.select({
    workspaceDirectory: "/workspace/project",
    profile: profile(),
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onChangeSelected() {
      persistenceAttempts += 1;
      if (persistenceAttempts === 1) throw new Error("диск недоступен");
    },
  });

  assert.deepEqual(change, { id: "selected-change" });
  assert.equal(results[0].isError, true);
  assert.match(firstText(results[0]), /надёжно сохранить/);
  assert.equal(results[1].isError, undefined);
  assert.deepEqual(labels, [
    ["agent-selection", false],
    ["agent-selection", true],
    ["agent-selection", false],
  ]);
});

test("сериализует параллельные set_change и сохраняет один результат", async () => {
  const labels = [];
  const persisted = [];
  const results = [];
  let toolFlow;
  const service = createChangeSelectionService({
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      toolFlow = (async () => {
        const client = await connectClient(url);
        try {
          results.push(
            ...(await Promise.all([
              client.callTool({
                name: "set_change",
                arguments: { changeId: "selected-change" },
              }),
              client.callTool({
                name: "set_change",
                arguments: { changeId: "selected-change" },
              }),
            ])),
          );
        } finally {
          await client.close();
        }
      })();
      return {
        id: "agent-selection",
        waitForFinish: async () => {
          await toolFlow;
          return { status: "idle" };
        },
      };
    },
    verifyChange: async (_workspace, changeId) => ({ id: changeId }),
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });

  await service.select({
    workspaceDirectory: "/workspace/project",
    profile: profile(),
    signal: new AbortController().signal,
    onAgentCreated() {},
    onChangeSelected: async (change) => persisted.push(change),
  });

  assert.equal(results.length, 2);
  assert.equal(results.every((result) => result.isError !== true), true);
  assert.deepEqual(persisted, [{ id: "selected-change" }]);
  assert.deepEqual(labels, [["agent-selection", false]]);
});

test("ошибка paseo CLI возвращается агенту и допускает повтор", async () => {
  const results = [];
  let labelAttempts = 0;
  let toolFlow;
  const service = createChangeSelectionService({
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      toolFlow = (async () => {
        const client = await connectClient(url);
        try {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            results.push(
              await client.callTool({
                name: "set_change",
                arguments: { changeId: "selected-change" },
              }),
            );
          }
        } finally {
          await client.close();
        }
      })();
      return {
        id: "agent-selection",
        waitForFinish: async () => {
          await toolFlow;
          return { status: "idle" };
        },
      };
    },
    verifyChange: async (_workspace, changeId) => ({ id: changeId }),
    async updateNotificationLabel() {
      labelAttempts += 1;
      if (labelAttempts === 1) throw new Error("Paseo CLI недоступен");
    },
    logger: { error() {}, warn() {} },
  });

  await service.select({
    workspaceDirectory: "/workspace/project",
    profile: profile(),
    signal: new AbortController().signal,
    onAgentCreated() {},
    onChangeSelected: async () => undefined,
  });

  assert.equal(results[0].isError, true);
  assert.match(firstText(results[0]), /отключить финальное уведомление/);
  assert.equal(results[1].isError, undefined);
  assert.equal(labelAttempts, 2);
});

test("отмена шага снимает ntfy, закрывает scope и не архивирует агента", async () => {
  const controller = new AbortController();
  const labels = [];
  let created;
  const service = createChangeSelectionService({
    async createAgent(options) {
      created = options;
      return {
        id: "agent-selection",
        waitForFinish: async () => ({ status: "idle" }),
      };
    },
    verifyChange: async (_workspace, changeId) => ({ id: changeId }),
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });

  const selecting = service.select({
    workspaceDirectory: "/workspace/project",
    profile: profile(),
    signal: controller.signal,
    onAgentCreated: () => controller.abort(),
    onChangeSelected: async () => undefined,
  });

  await assert.rejects(selecting, /отменена/);
  assert.deepEqual(created.labels, { ntfy: "true" });
  assert.deepEqual(labels, [["agent-selection", false]]);
});
