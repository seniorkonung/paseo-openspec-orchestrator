import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
let temporaryDirectory;
let registerOrchestratorComposerPills;

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "openspec-composer-pills-"));
  const outfile = join(temporaryDirectory, "composer-pills.mjs");
  await build({
    entryPoints: [join(projectDirectory, "client", "orchestrator-composer-pills.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  ({ registerOrchestratorComposerPills } = await import(pathToFileURL(outfile).href));
});

after(() => rm(temporaryDirectory, { recursive: true, force: true }));

function agent(id, workspaceId = "workspace-1") {
  return { id, workspaceId, archivedAt: null };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createOwnedSubscription(snapshot) {
  const observers = new Set();
  let current = snapshot;
  const subscription = {
    subscriptionId: "host-assigned",
    released: 0,
    subscribe(observer) {
      observers.add(observer);
      observer.snapshot(current);
      return () => observers.delete(observer);
    },
    async release() {
      subscription.released += 1;
      observers.clear();
    },
    restore(nextSnapshot) {
      current = nextSnapshot;
      for (const observer of observers) observer.snapshot(current);
    },
  };
  return subscription;
}

// Воспроизводит контракт клиента Paseo 0.10: ID подписки назначает хост,
// а список возвращает owned-подписку, которую плагин обязан освободить.
function createHost({ ownedSubscriptions = true, agents = [], listGate = null } = {}) {
  const listeners = new Set();
  const pills = new Map();
  const listCalls = [];
  const opened = [];
  let subscription = null;

  const client = {
    paseo: {
      agents: {
        async list(options) {
          listCalls.push(options);
          if (options.subscribe?.subscriptionId !== undefined) {
            throw new Error("Subscription IDs are assigned by the host");
          }
          await listGate;
          const page = {
            requestId: `request-${listCalls.length}`,
            entries: agents.map((item) => ({ agent: item })),
            pageInfo: { nextCursor: null },
          };
          if (!options.subscribe || !ownedSubscriptions) return page;
          subscription = createOwnedSubscription({ ...page, subscriptionId: "host-assigned" });
          return { ...page, subscriptionId: "host-assigned", subscription };
        },
        subscribe(handler) {
          listeners.add(handler);
          return () => listeners.delete(handler);
        },
      },
    },
    async rpc(_definition, { workspaceId }) {
      return { installed: workspaceId === "workspace-1" };
    },
    addComposerPill(contribution) {
      pills.set(contribution.agentId, contribution);
      return {
        remove() {
          pills.delete(contribution.agentId);
        },
      };
    },
    openPanel(id, options) {
      opened.push({ id, options });
    },
  };

  return {
    client,
    listCalls,
    opened,
    pills,
    get subscription() {
      return subscription;
    },
    emit(update) {
      for (const listener of listeners) listener(update);
    },
  };
}

test("запрашивает подписку на агентов без собственного идентификатора", async () => {
  const host = createHost({ agents: [agent("agent-1")] });
  const stop = registerOrchestratorComposerPills(host.client);
  await flush();

  assert.deepEqual(host.listCalls[0].subscribe, {});
  assert.deepEqual([...host.pills.keys()], ["agent-1"]);
  stop();
});

test("шильдик открывает панель оркестратора своей рабочей области", async () => {
  const host = createHost({ agents: [agent("agent-1")] });
  const stop = registerOrchestratorComposerPills(host.client);
  await flush();

  host.pills.get("agent-1").button.behavior.onPress();

  assert.deepEqual(host.opened, [
    { id: "orchestrator", options: { workspaceId: "workspace-1" } },
  ]);
  stop();
});

test("не показывает шильдик в рабочей области без OpenSpec", async () => {
  const host = createHost({ agents: [agent("agent-1", "workspace-2")] });
  const stop = registerOrchestratorComposerPills(host.client);
  await flush();

  assert.equal(host.pills.size, 0);
  stop();
});

test("освобождает подписку хоста и убирает шильдики при очистке", async () => {
  const host = createHost({ agents: [agent("agent-1")] });
  const stop = registerOrchestratorComposerPills(host.client);
  await flush();

  stop();

  assert.equal(host.subscription.released, 1);
  assert.equal(host.pills.size, 0);
});

test("освобождает подписку, полученную после очистки", async () => {
  let openGate;
  const listGate = new Promise((resolve) => {
    openGate = resolve;
  });
  const host = createHost({ agents: [agent("agent-1")], listGate });
  const stop = registerOrchestratorComposerPills(host.client);

  stop();
  openGate();
  await flush();

  assert.equal(host.subscription.released, 1);
  assert.equal(host.pills.size, 0);
});

test("добавляет шильдик агенту из снимка после переподключения", async () => {
  const host = createHost({ agents: [agent("agent-1")] });
  const stop = registerOrchestratorComposerPills(host.client);
  await flush();

  host.subscription.restore({
    requestId: "restored",
    subscriptionId: "host-assigned-2",
    entries: [{ agent: agent("agent-1") }, { agent: agent("agent-2") }],
    pageInfo: { nextCursor: null },
  });
  await flush();

  assert.deepEqual([...host.pills.keys()].sort(), ["agent-1", "agent-2"]);
  stop();
});

test("работает с хостом без owned-подписок через поток обновлений агентов", async () => {
  const host = createHost({ ownedSubscriptions: false });
  const stop = registerOrchestratorComposerPills(host.client);
  await flush();

  host.emit({ kind: "upsert", agent: agent("agent-1") });
  await flush();
  assert.deepEqual([...host.pills.keys()], ["agent-1"]);

  host.emit({ kind: "remove", agentId: "agent-1" });
  assert.equal(host.pills.size, 0);
  stop();
});
