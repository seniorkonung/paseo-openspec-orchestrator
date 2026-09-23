import assert from "node:assert/strict";
import test from "node:test";
import { deliverRootCommit, RootBranchDeliveryError } from "../server/root-branch-delivery.ts";

const changeId = "one-pr";
const branch = `change/${changeId}`;
const base = "a".repeat(40);
const head = "b".repeat(40);
const other = "c".repeat(40);
const repositoryUrl = "https://github.com/example/project";

function fixture(options = {}) {
  let remote = options.remote ?? base;
  let pushed = false;
  const calls = [];
  const pr = () => ({
    number: 41,
    url: `${repositoryUrl}/pull/41`,
    state: options.prState ?? "OPEN",
    isDraft: options.isDraft ?? true,
    isCrossRepository: false,
    baseRefName: pushed ? options.afterPushBase ?? "main" : "main",
    headRefName: branch,
    headRefOid: options.prHead ?? remote,
    mergeCommit: options.prState === "MERGED" ? { oid: head } : null,
    title: "Корневой PR",
    body: "Описание",
  });
  const command = async (executable, args) => {
    const key = `${executable} ${args.join(" ")}`;
    calls.push(key);
    if (key === "git status --porcelain=v1 --untracked-files=all") return { stdout: "", stderr: "" };
    if (key === "git branch --show-current") return { stdout: `${branch}\n`, stderr: "" };
    if (key === "git rev-parse HEAD") return { stdout: `${options.local ?? head}\n`, stderr: "" };
    if (key === `git ls-remote --heads origin refs/heads/${branch}`) {
      return { stdout: `${remote}\trefs/heads/${branch}\n`, stderr: "" };
    }
    if (key === "git remote get-url origin") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (key.startsWith("gh auth status ")) return { stdout: "", stderr: "" };
    if (key.startsWith("gh repo view ")) {
      return { stdout: JSON.stringify({ nameWithOwner: "example/project", url: repositoryUrl }), stderr: "" };
    }
    if (key.startsWith("gh pr list ") || key.startsWith("gh pr view ")) {
      return { stdout: JSON.stringify(key.startsWith("gh pr list ") ? [pr()] : pr()), stderr: "" };
    }
    if (key === `git merge-base --is-ancestor ${base} ${head}`) {
      return { stdout: "", stderr: "" };
    }
    if (key === `git push origin HEAD:refs/heads/${branch}`) {
      remote = head;
      pushed = true;
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Неожиданная команда: ${key}`);
  };
  return { command, calls, remote: () => remote };
}

test("проверенный коммит публикуется только в корневую ветку единственного Draft PR", async () => {
  const state = fixture();
  await deliverRootCommit("/repo", changeId, base, head, undefined, state.command);
  assert.equal(state.remote(), head);
  assert.deepEqual(state.calls.filter((call) => call.startsWith("git push")), [
    `git push origin HEAD:refs/heads/${branch}`,
  ]);
  assert.equal(state.calls.some((call) => call.includes("pr create")), false);
});

test("повтор после push подтверждает HEAD без второго push", async () => {
  const state = fixture({ remote: head });
  await deliverRootCommit("/repo", changeId, base, head, undefined, state.command);
  assert.equal(state.calls.some((call) => call.startsWith("git push")), false);
});

test("расхождение origin и преждевременный merge останавливают публикацию", async () => {
  for (const options of [{ remote: other }, { prState: "MERGED" }, { isDraft: false }, { prHead: other }]) {
    const state = fixture(options);
    await assert.rejects(
      deliverRootCommit("/repo", changeId, base, head, undefined, state.command),
      RootBranchDeliveryError,
    );
    assert.equal(state.calls.some((call) => call.startsWith("git push")), false);
  }
});

test("изменение base корневого PR после push останавливает подтверждение", async () => {
  const state = fixture({ afterPushBase: "release" });
  await assert.rejects(
    deliverRootCommit("/repo", changeId, base, head, undefined, state.command),
    RootBranchDeliveryError,
  );
  assert.equal(state.remote(), head);
});
