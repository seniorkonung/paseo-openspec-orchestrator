import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runBoundedCommand } from "../server/bounded-command.ts";
import {
  findNearestAncestor,
  isCommitAncestor,
  isKnownCommit,
} from "../server/git-ancestry.ts";

const execFileAsync = promisify(execFile);
const unknownCommit = "f".repeat(40);

async function repository(context) {
  const directory = await mkdtemp(join(tmpdir(), "git-ancestry-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const git = async (...args) =>
    (await execFileAsync("git", args, { cwd: directory })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "OpenSpec Test");
  await git("config", "user.email", "openspec@example.test");
  const commit = async (name) => {
    await writeFile(join(directory, `${name}.txt`), `${name}\n`);
    await git("add", ".");
    await git("commit", "-m", name);
    return git("rev-parse", "HEAD");
  };
  return { directory, git, commit };
}

test("предок, потомок и неизвестный коммит различаются по ответу Git", async (context) => {
  const { directory, git, commit } = await repository(context);
  const base = await commit("base");
  const head = await commit("head");
  await git("checkout", "-q", "-b", "side", base);
  const side = await commit("side");

  assert.equal(await isCommitAncestor(runBoundedCommand, directory, base, head), true);
  assert.equal(await isCommitAncestor(runBoundedCommand, directory, head, head), true);
  assert.equal(await isCommitAncestor(runBoundedCommand, directory, head, base), false);
  assert.equal(await isCommitAncestor(runBoundedCommand, directory, side, head), false);
  assert.equal(await isCommitAncestor(runBoundedCommand, directory, unknownCommit, head), false);

  assert.equal(await findNearestAncestor(runBoundedCommand, directory, base, head), base);
  assert.equal(await findNearestAncestor(runBoundedCommand, directory, side, head), base);
  assert.equal(await findNearestAncestor(runBoundedCommand, directory, unknownCommit, head), null);

  assert.equal(await isKnownCommit(runBoundedCommand, directory, side), true);
  assert.equal(await isKnownCommit(runBoundedCommand, directory, unknownCommit), false);
});

test("истории без общего предка не имеют ближайшего коммита", async (context) => {
  const { directory, git, commit } = await repository(context);
  const head = await commit("head");
  await git("checkout", "-q", "--orphan", "unrelated");
  const unrelated = await commit("unrelated");
  assert.equal(await findNearestAncestor(runBoundedCommand, directory, head, unrelated), null);
});

test("команда без кода выхода не считается ответом об истории", async () => {
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  // Тайм-аут и недоступный git не сообщают, является ли коммит предком.
  for (const failure of [
    Object.assign(new Error("Команда прервана по тайм-ауту"), { killed: true, signal: "SIGTERM" }),
    Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
  ]) {
    const command = async () => { throw failure; };
    await assert.rejects(isCommitAncestor(command, "/repo", base, head), failure);
    await assert.rejects(findNearestAncestor(command, "/repo", base, head), failure);
    await assert.rejects(isKnownCommit(command, "/repo", base), failure);
  }

  // Прерванная операция завершается исключением даже при коде выхода.
  const controller = new AbortController();
  controller.abort();
  const aborted = Object.assign(new Error("прервано"), { code: 1 });
  await assert.rejects(
    isCommitAncestor(async () => { throw aborted; }, "/repo", base, head, controller.signal),
    aborted,
  );
});
