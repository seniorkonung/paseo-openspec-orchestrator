import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createAgentProcessCleaner, createLinuxAgentProcessTable } from "../server/agent-process-cleanup.ts";
import { AgentCleanupBudget } from "../server/agent-cleanup-budget.ts";

const execFileAsync = promisify(execFile);
const linux = process.platform === "linux";

async function detachedFixture(context, ignoreTerm = false) {
  const agentId = randomUUID();
  const childCode = `${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ''} process.send("ready"); process.disconnect(); setInterval(() => {}, 1000);`;
  const launcher = `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e",process.env.FIXTURE_CHILD_CODE],{env:{...process.env,PASEO_AGENT_ID:process.env.FIXTURE_AGENT_ID},detached:true,stdio:["ignore","ignore","ignore","ipc"]}); child.once("message",()=>{console.log(child.pid);child.unref();});`;
  const { stdout } = await execFileAsync(process.execPath, ["-e", launcher], {
    env: { ...process.env, FIXTURE_CHILD_CODE: childCode, FIXTURE_AGENT_ID: agentId }, timeout: 5_000,
  });
  const pid = Number(stdout.trim());
  context.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  return { agentId, pid };
}

test("находит отделившегося потомка по метке, сохраняя процесс другой сессии", { skip: !linux }, async (context) => {
  const owned = await detachedFixture(context);
  const unrelated = await detachedFixture(context);
  const fields = (await readFile(`/proc/${owned.pid}/stat`, "utf8")).split(")").at(-1).trim().split(/\s+/);
  assert.notEqual(Number(fields[1]), process.pid);
  const table = createLinuxAgentProcessTable();
  const found = await table.list(new Set([owned.agentId]));
  assert.deepEqual(found.map(({ pid }) => pid), [owned.pid]);
  await createAgentProcessCleaner({ table })([owned.agentId]);
  assert.deepEqual(await table.list(new Set([owned.agentId])), []);
  assert.equal((await table.list(new Set([unrelated.agentId]))).some(({ pid }) => pid === unrelated.pid), true);
});

test("применяет SIGKILL к отделившемуся процессу, игнорирующему SIGTERM", { skip: !linux }, async (context) => {
  const owned = await detachedFixture(context, true);
  const signals = [];
  const table = createLinuxAgentProcessTable({ sendSignal(pid, signal) { signals.push(signal); process.kill(pid, signal); } });
  await createAgentProcessCleaner({ table, gracefulTimeoutMs: 100, forceTimeoutMs: 500, pollIntervalMs: 20 })([owned.agentId]);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(await table.list(new Set([owned.agentId])), []);
});

async function procFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "agent-proc-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const pid = 900000001;
  const directory = join(root, String(pid));
  await mkdir(directory);
  const update = async (startedAt, agentId) => {
    const fields = Array(20).fill("0");
    fields[0] = "S";
    fields[19] = startedAt;
    await writeFile(join(directory, "stat"), `${pid} (имя с ) скобкой) ${fields.join(" ")}`);
    await writeFile(join(directory, "environ"), `OTHER=секрет\0PASEO_AGENT_ID=${agentId}\0`);
  };
  await update("100", "owned-agent");
  const signals = [];
  const table = createLinuxAgentProcessTable({ procRoot: root, sendSignal: (...args) => signals.push(args) });
  return { root, pid, table, signals, update };
}

test("повторно проверяет время запуска и метку непосредственно перед сигналом", { skip: !linux }, async (context) => {
  const value = await procFixture(context);
  const [target] = await value.table.list(new Set(["owned-agent"]));
  assert.equal(target.pid, value.pid);
  await value.update("200", "owned-agent");
  await value.table.signal(target, "SIGKILL");
  await value.update("100", "different-agent");
  await value.table.signal(target, "SIGKILL");
  assert.deepEqual(value.signals, []);
  await value.update("100", "owned-agent");
  await value.table.signal(target, "SIGTERM");
  assert.deepEqual(value.signals, [[value.pid, "SIGTERM"]]);
});

test("после исчерпания общего срока не посылает сигнал известному процессу", { skip: !linux }, async (context) => {
  const value = await procFixture(context);
  const [target] = await value.table.list(new Set(["owned-agent"]));
  let elapsed = 0;
  const budget = new AgentCleanupBudget(60_000, 20_000, { now: () => elapsed, async sleep() {} });
  elapsed = 60_000;
  await assert.rejects(value.table.signal(target, "SIGTERM", budget), /Истёк общий срок/u);
  assert.deepEqual(value.signals, []);
});

test("пропускает чужой UID и требует точного значения ID", { skip: !linux }, async (context) => {
  const value = await procFixture(context);
  assert.deepEqual(await value.table.list(new Set(["owned"])), []);
  const foreign = createLinuxAgentProcessTable({ procRoot: value.root, uid: process.getuid() + 1 });
  assert.deepEqual(await foreign.list(new Set(["owned-agent"])), []);
});

test("сообщает оставшиеся PID после исчерпания срока принудительного завершения", async () => {
  const signals = [];
  const clean = createAgentProcessCleaner({ platform: "linux", gracefulTimeoutMs: 0, forceTimeoutMs: 0,
    table: { list: async () => [{ pid: 123, uid: 1, startedAt: "100", agentId: "owned" }],
      async signal(_target, signal) { signals.push(signal); } },
  });
  await assert.rejects(clean(["owned"]), /123/u);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("на других ОС не обращается к Linux-таблице процессов", async () => {
  await createAgentProcessCleaner({ platform: "darwin", table: {
    async list() { throw new Error("Не должна вызываться"); }, async signal() {},
  } })(["owned"]);
});

test("потеря доступа к известному процессу не теряется между очистками разных сессий", { skip: !linux || process.getuid?.() === 0 }, async (context) => {
  const value = await procFixture(context);
  await value.table.list(new Set(["owned-agent"]));
  await value.table.list(new Set(["different-agent"]));
  await chmod(join(value.root, String(value.pid), "environ"), 0);
  assert.deepEqual(await value.table.list(new Set(["different-agent"])), []);
  await assert.rejects(value.table.list(new Set(["owned-agent"])), /принадлежность процесса/u);
  await chmod(join(value.root, String(value.pid), "environ"), 0o600);
  await chmod(join(value.root, String(value.pid), "stat"), 0);
  await assert.rejects(value.table.list(new Set(["owned-agent"])), /принадлежность процесса/u);
});
