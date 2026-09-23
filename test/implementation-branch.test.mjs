import assert from "node:assert/strict";
import test from "node:test";
import { createImplementationBranchService } from "../server/implementation-branch.ts";
import { createImplementationRunVerifier } from "../server/implementation-run-verification.ts";

const changeId = "implementation-cycle";
const branch = `change/${changeId}`;
const baseline = "a".repeat(40);

function fixture() {
  let head = baseline;
  let state = "OPEN";
  const calls = [];
  const pr = () => ({
    number: 7, url: "https://github.com/example/project/pull/7", state,
    isDraft: state === "OPEN", isCrossRepository: false, baseRefName: "main",
    headRefName: branch, headRefOid: head, title: "Change", body: "Описание",
  });
  const command = async (executable, args) => {
    const key = `${executable} ${args.join(" ")}`;
    calls.push(key);
    if (key === "git status --porcelain=v1 --untracked-files=all") return { stdout: "", stderr: "" };
    if (key === "git branch --show-current") return { stdout: `${branch}\n`, stderr: "" };
    if (key === "git rev-parse HEAD") return { stdout: `${head}\n`, stderr: "" };
    if (key === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "" };
    if (key === `git for-each-ref --format=%(objectname)%00%(refname) refs/heads/${branch}`) {
      return { stdout: `${head}\0refs/heads/${branch}\n`, stderr: "" };
    }
    if (key === `git merge-base --is-ancestor ${baseline} ${head}`) return { stdout: "", stderr: "" };
    if (key === `git ls-remote --heads origin refs/heads/${branch}`) return { stdout: `${head}\trefs/heads/${branch}\n`, stderr: "" };
    if (key === "git remote get-url origin") return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    if (key.startsWith("gh auth status ")) return { stdout: "", stderr: "" };
    if (key.startsWith("gh repo view ")) return { stdout: JSON.stringify({ nameWithOwner: "example/project", url: "https://github.com/example/project" }), stderr: "" };
    if (key.startsWith("gh pr list ")) return { stdout: JSON.stringify([pr()]), stderr: "" };
    if (key.startsWith("gh pr view ")) return { stdout: JSON.stringify(pr()), stderr: "" };
    throw new Error(`Неожиданная команда: ${key}`);
  };
  return { command, calls, changeHead: (value) => { head = value; }, merge: () => { state = "MERGED"; } };
}

test("implementation run использует только корневую ветку и Draft PR", async () => {
  const value = fixture();
  const service = createImplementationBranchService({ command: value.command });
  const session = await service.prepare("/repo", changeId, branch, 2, 3);
  assert.equal(session.implementationBranch, branch);
  const run = await service.activate("/repo", session);
  assert.equal(run.implementationBranch, branch);
  assert.equal(run.phaseNumber, 2);
  assert.equal(run.runNumber, 3);
  assert.deepEqual(run.publication, { kind: "unreviewed" });
  assert.equal(await createImplementationRunVerifier({ command: value.command }).assertCurrent("/repo", run), baseline);
  assert.equal(value.calls.some((call) => call.includes("pr create") || call.includes("git switch")), false);
});

test("implementation run останавливается при изменении baseline и преждевременном merge", async () => {
  const value = fixture();
  const service = createImplementationBranchService({ command: value.command });
  const session = await service.prepare("/repo", changeId, branch);
  value.merge();
  await assert.rejects(service.activate("/repo", session));
  const other = fixture();
  const next = createImplementationBranchService({ command: other.command });
  const saved = await next.prepare("/repo", changeId, branch);
  other.changeHead("b".repeat(40));
  await assert.rejects(next.activate("/repo", saved), /изменилась/u);
});
