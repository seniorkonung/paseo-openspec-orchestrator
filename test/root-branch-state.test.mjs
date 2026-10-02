import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { RootBranchDeliveryError } from "../server/root-branch-delivery.ts";
import { createRootBranchService } from "../server/root-branch-state.ts";

const execFileAsync = promisify(execFile);
const changeId = "branch-state";
const changeBranch = `change/${changeId}`;

async function fixture(context, { pullRequest = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "root-branch-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const remote = join(root, "origin.git");
  const git = async (...args) =>
    (await execFileAsync("git", args, { cwd: workspace })).stdout.trim();
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["init", "-b", changeBranch, workspace]);
  await git("config", "user.name", "OpenSpec Test");
  await git("config", "user.email", "openspec@example.test");
  const commit = async (name) => {
    await writeFile(join(workspace, `${name}.txt`), `${name}\n`);
    await git("add", ".");
    await git("commit", "-m", name);
    return git("rev-parse", "HEAD");
  };
  const baseline = await commit("baseline");
  await git("remote", "add", "origin", remote);

  // Git выполняется по-настоящему; GitHub CLI заменён управляемым ответом.
  const calls = [];
  const command = async (executable, args, options) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "git" && args.join(" ") === "remote get-url origin") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (executable === "gh" && args[0] === "auth") return { stdout: "", stderr: "" };
    if (executable === "gh" && args[0] === "repo") {
      return {
        stdout: JSON.stringify({ nameWithOwner: "example/project", url: "https://github.com/example/project" }),
        stderr: "",
      };
    }
    if (executable === "gh" && args[0] === "pr") {
      const remoteHead = (await git("ls-remote", "--heads", "origin", `refs/heads/${changeBranch}`))
        .split(/\s/u)[0];
      const pr = {
        number: 41, url: "https://github.com/example/project/pull/41", state: "OPEN",
        isDraft: true, isCrossRepository: false, baseRefName: "main",
        headRefName: changeBranch, headRefOid: remoteHead, title: "Change", body: "Описание",
        ...pullRequest,
      };
      return { stdout: JSON.stringify(args[1] === "list" ? [pr] : pr), stderr: "" };
    }
    const result = await execFileAsync(executable, args, { cwd: options.cwd, encoding: "utf8" });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
  return {
    root, workspace, remote, baseline, git, commit, calls,
    service: createRootBranchService({ command }),
  };
}

test("другая ветка и грязное дерево делают корневую ветку недоступной для сверки", async (context) => {
  const value = await fixture(context);
  await writeFile(join(value.workspace, "draft.txt"), "черновик\n");
  assert.deepEqual(await value.service.inspect(value.workspace, changeBranch), {
    kind: "unavailable",
    reason: "dirty-worktree",
  });
  await rm(join(value.workspace, "draft.txt"));
  await value.git("checkout", "-b", "feature/other");
  assert.deepEqual(await value.service.inspect(value.workspace, changeBranch), {
    kind: "unavailable",
    reason: "other-branch",
  });
});

test("положение origin различает отсутствие ветки, совпадение и неопубликованные коммиты", async (context) => {
  const value = await fixture(context);
  assert.deepEqual(await value.service.inspect(value.workspace, changeBranch), {
    kind: "available",
    head: value.baseline,
    origin: { kind: "absent" },
  });
  await value.git("push", "origin", changeBranch);
  assert.deepEqual((await value.service.inspect(value.workspace, changeBranch)).origin, {
    kind: "synchronized",
  });
  await value.commit("first");
  const head = await value.commit("second");
  assert.deepEqual(await value.service.inspect(value.workspace, changeBranch), {
    kind: "available",
    head,
    origin: { kind: "unpublished", remoteHead: value.baseline, commits: 2 },
  });
});

test("неопубликованные коммиты публикуются fast-forward и без требования Draft", async (context) => {
  const value = await fixture(context, { pullRequest: { isDraft: false } });
  await value.git("push", "origin", changeBranch);
  const head = await value.commit("accepted");
  await value.service.publish(value.workspace, changeId, value.baseline, head);
  assert.deepEqual((await value.service.inspect(value.workspace, changeBranch)).origin, {
    kind: "synchronized",
  });
  assert.equal(value.calls.filter((call) => call.startsWith("git push ")).length, 1);
  assert.equal(value.calls.some((call) => call.includes("--force")), false);
});

test("закрытый корневой PR не позволяет публиковать принятые коммиты", async (context) => {
  const value = await fixture(context, { pullRequest: { state: "CLOSED" } });
  await value.git("push", "origin", changeBranch);
  const head = await value.commit("after-close");
  await assert.rejects(
    value.service.publish(value.workspace, changeId, value.baseline, head),
    RootBranchDeliveryError,
  );
  assert.equal(value.calls.some((call) => call.startsWith("git push ")), false);
});

test("отставание, переписанная история и неполученные коммиты origin различаются", async (context) => {
  const value = await fixture(context);
  const published = await value.commit("published");
  await value.git("push", "origin", changeBranch);

  await value.git("reset", "--hard", value.baseline);
  assert.deepEqual((await value.service.inspect(value.workspace, changeBranch)).origin, {
    kind: "behind",
    remoteHead: published,
  });

  await value.git("reset", "--hard", published);
  await value.git("commit", "--amend", "-m", "published, переписан");
  assert.deepEqual((await value.service.inspect(value.workspace, changeBranch)).origin, {
    kind: "diverged",
    remoteHead: published,
  });

  // Другой клон публикует коммит, которого в этой рабочей области ещё нет.
  await value.git("reset", "--hard", published);
  const other = join(value.root, "other");
  await execFileAsync("git", ["clone", "--branch", changeBranch, value.remote, other]);
  await execFileAsync("git", ["config", "user.name", "Other"], { cwd: other });
  await execFileAsync("git", ["config", "user.email", "other@example.test"], { cwd: other });
  await writeFile(join(other, "foreign.txt"), "чужой коммит\n");
  await execFileAsync("git", ["add", "."], { cwd: other });
  await execFileAsync("git", ["commit", "-m", "foreign"], { cwd: other });
  await execFileAsync("git", ["push", "origin", changeBranch], { cwd: other });
  const foreign = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: other })).stdout.trim();
  assert.deepEqual((await value.service.inspect(value.workspace, changeBranch)).origin, {
    kind: "unfetched",
    remoteHead: foreign,
  });
});

test("ближайший предок сохраняет коммит истории и заменяет переписанный общим предком", async (context) => {
  const value = await fixture(context);
  const kept = await value.commit("kept");
  const rewritten = await value.commit("rewritten");
  await value.git("commit", "--amend", "-m", "rewritten, новая версия");
  const head = await value.git("rev-parse", "HEAD");
  const unknown = "f".repeat(40);
  const nearest = await value.service.nearestAncestors(
    value.workspace,
    [value.baseline, kept, rewritten, unknown, kept],
    head,
  );
  assert.deepEqual([...nearest], [
    [value.baseline, value.baseline],
    [kept, kept],
    [rewritten, kept],
    [unknown, null],
  ]);
});
