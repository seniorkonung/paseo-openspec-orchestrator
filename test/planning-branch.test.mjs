import assert from "node:assert/strict";
import test from "node:test";
import { createPlanningBranchService } from "../server/planning-branch.ts";

const changeId = "planning-contract";
const branch = `change/${changeId}`;
const baseline = "a".repeat(40);

function fixture() {
  let head = baseline;
  let draft = true;
  const calls = [];
  const pr = () => ({
    number: 7, url: "https://github.com/example/project/pull/7", state: "OPEN",
    isDraft: draft, isCrossRepository: false, baseRefName: "main",
    headRefName: branch, headRefOid: head, title: "Change", body: "Описание",
  });
  const command = async (executable, args) => {
    const key = `${executable} ${args.join(" ")}`;
    calls.push(key);
    if (key === "git status --porcelain=v1 --untracked-files=all") return { stdout: "", stderr: "" };
    if (key === "git branch --show-current") return { stdout: `${branch}\n`, stderr: "" };
    if (key === "git rev-parse HEAD") return { stdout: `${head}\n`, stderr: "" };
    if (key === `git ls-remote --heads origin refs/heads/${branch}`) return { stdout: `${head}\trefs/heads/${branch}\n`, stderr: "" };
    if (key === "git remote get-url origin") return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    if (key.startsWith("gh auth status ")) return { stdout: "", stderr: "" };
    if (key.startsWith("gh repo view ")) return { stdout: JSON.stringify({ nameWithOwner: "example/project", url: "https://github.com/example/project" }), stderr: "" };
    if (key.startsWith("gh pr list ")) return { stdout: JSON.stringify([pr()]), stderr: "" };
    if (key.startsWith("gh pr view ")) return { stdout: JSON.stringify(pr()), stderr: "" };
    if (key.startsWith("gh pr ready ") && key.includes("--undo")) {
      draft = true;
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Неожиданная команда: ${key}`);
  };
  return { command, calls, changeHead: (value) => { head = value; }, makeReady: () => { draft = false; } };
}

test("planning остаётся на корневой ветке и восстанавливается из checkpoint", async () => {
  const state = fixture();
  const service = createPlanningBranchService({ command: state.command });
  const session = await service.prepare("/repo", changeId, branch);
  assert.deepEqual(session, { changeId, changeBranch: branch, planningBranch: branch, baselineCommit: baseline });
  assert.equal(await service.activate("/repo", session), branch);
  assert.equal(await service.activate("/repo", session), branch);
  assert.equal(state.calls.some((call) => call.includes("pr create") || call.includes("git switch")), false);
});

test("planning возвращает преждевременно Ready PR в Draft и замечает изменение HEAD", async () => {
  const state = fixture();
  const service = createPlanningBranchService({ command: state.command });
  const session = await service.prepare("/repo", changeId, branch);
  state.makeReady();
  assert.equal(await service.activate("/repo", session), branch);
  assert.equal(state.calls.some((call) => call.startsWith("gh pr ready ") && call.includes("--undo")), true);
  const other = fixture();
  const next = createPlanningBranchService({ command: other.command });
  const saved = await next.prepare("/repo", changeId, branch);
  other.changeHead("b".repeat(40));
  await assert.rejects(next.activate("/repo", saved), /изменилась/u);
});
