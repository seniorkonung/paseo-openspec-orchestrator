import assert from "node:assert/strict";
import test from "node:test";
import { createRootPullRequestService } from "../server/root-pull-request.ts";

const changeId = "root-gate";
const changeBranch = `change/${changeId}`;
const head = "a".repeat(40);
const repositoryUrl = "https://github.com/example/project";

function commandFor(state) {
  const pullRequest = {
    number: 41,
    url: `${repositoryUrl}/pull/41`,
    state,
    isDraft: state === "OPEN",
    isCrossRepository: false,
    baseRefName: "main",
    headRefName: changeBranch,
    headRefOid: head,
    title: "Корневой PR",
    body: "Описание",
  };
  return async (executable, arguments_) => {
    const key = `${executable} ${arguments_.join(" ")}`;
    if (key === "git status --porcelain=v1 --untracked-files=all") return { stdout: "", stderr: "" };
    if (key === "git branch --show-current") return { stdout: `${changeBranch}\n`, stderr: "" };
    if (key === "git rev-parse HEAD") return { stdout: `${head}\n`, stderr: "" };
    if (key.startsWith("git for-each-ref ")) {
      return { stdout: `${head}\0refs/heads/${changeBranch}\n`, stderr: "" };
    }
    if (key.startsWith("git ls-remote --heads origin ")) return { stdout: "", stderr: "" };
    if (key === "git remote get-url origin") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (key.startsWith("gh auth status ")) return { stdout: "", stderr: "" };
    if (key.startsWith("gh repo view ")) {
      return { stdout: JSON.stringify({ nameWithOwner: "example/project", url: repositoryUrl }), stderr: "" };
    }
    if (key.startsWith("gh pr list ")) return { stdout: JSON.stringify([pullRequest]), stderr: "" };
    if (key.startsWith("gh pr view ")) return { stdout: JSON.stringify(pullRequest), stderr: "" };
    throw new Error(`Неожиданная команда: ${key}`);
  };
}

test("финальный gate принимает merged root PR с точным local head после удаления remote branch", async () => {
  const service = createRootPullRequestService({ command: commandFor("MERGED") });
  assert.equal(await service.synchronize("/repo", changeId, changeBranch), head);
  const inspection = await service.inspect("/repo", changeId, changeBranch, null);
  assert.equal(inspection.kind, "merged");
  assert.equal(inspection.head, head);
  assert.equal(inspection.identity.number, 41);
});

test("открытый root PR без remote head отклоняется", async () => {
  const service = createRootPullRequestService({ command: commandFor("OPEN") });
  await assert.rejects(
    service.inspect("/repo", changeId, changeBranch, null),
    /неверные repository, base, head или commit/u,
  );
});
