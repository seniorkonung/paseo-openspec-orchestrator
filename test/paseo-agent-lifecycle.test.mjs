import assert from "node:assert/strict";
import test from "node:test";
import { resolvePaseoHome } from "../server/paseo-home.ts";
import { markPaseoAgentPreserved, stopPaseoAgent } from "../server/paseo-agent-lifecycle.ts";

test("остановка проверяет состояние демона после команды и передаёт точный ID", async () => {
  let status = "running";
  const calls = [];
  const agent = { id: "--all", async refresh() { return { agent: { status } }; } };
  await stopPaseoAgent(agent, async (...args) => { calls.push(args); status = "idle"; }, 50);
  assert.deepEqual(calls[0].slice(0, 2), ["paseo", ["agent", "stop", "--json", "--home", resolvePaseoHome(), "--", "--all"]]);
  assert.equal(calls[0][2].timeoutMs, 50);
  assert.equal(calls[0][2].signal.aborted, false);
});

test("нулевой код CLI не скрывает неудавшуюся остановку", async () => {
  const agent = { id: "running", async refresh() { return { agent: { status: "running" } }; } };
  await assert.rejects(stopPaseoAgent(agent, async () => ({ stdout: "{}", stderr: "Ошибка отмены" }), 5), /не подтвердил остановку/u);
});

test("остановка не посылает команду отсутствующему, архивному или остановленному агенту", async () => {
  for (const snapshot of [null, { agent: { status: "idle" } }, { agent: { status: "error" } }, { agent: { status: "running", archivedAt: "2026-10-14" } }]) {
    await stopPaseoAgent({ id: "agent", async refresh() { return snapshot; } }, async () => assert.fail("Команда не требуется"));
  }
});

test("метка ручного управления записывается отдельным ограниченным вызовом", async () => {
  const calls = [];
  await markPaseoAgentPreserved("agent-id", async (...args) => { calls.push(args); }, 100);
  assert.deepEqual(calls, [["paseo", ["agent", "update", "--label", "openspec-preserved=true", "--json", "--home", resolvePaseoHome(), "--", "agent-id"], { timeoutMs: 100 }]]);
});

test("запоздавший refresh после таймаута не останавливает ручное продолжение", async () => {
  let finishRefresh;
  let delayed = true;
  let status = "running";
  const agent = { id: "agent", async refresh() {
    if (delayed) return new Promise((resolve) => { finishRefresh = resolve; });
    return { agent: { status } };
  } };
  let stops = 0;
  const command = async () => { stops++; status = "idle"; };
  await assert.rejects(stopPaseoAgent(agent, command, 5), /не подтвердил остановку/u);
  delayed = false;
  await stopPaseoAgent(agent, command, 50);
  status = "running";
  finishRefresh({ agent: { status: "running" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stops, 1);
  assert.equal(status, "running");
});
