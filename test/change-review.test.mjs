import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { prepareReviewPublication } from "../server/change-review-publication.ts";
import { createChangeReviewVerification } from "../server/change-review-verification.ts";
import { reviewCommitSubject, changeReviewPrompt } from "../server/change-review.ts";

const execFileAsync = promisify(execFile);
const changeId = "complete-review-workflow";
const branch = `change/${changeId}`;
const repositoryUrl = "https://github.com/example/project";

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "openspec-review-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const changeRoot = join(workspace, "openspec", "changes", changeId);
  await mkdir(changeRoot, { recursive: true });
  const git = async (...args) => (await execFileAsync("git", args, { cwd: workspace })).stdout.trim();
  await git("init", "-b", branch);
  await git("config", "user.name", "OpenSpec Test");
  await git("config", "user.email", "openspec@example.test");
  await writeFile(join(changeRoot, ".openspec.yaml"), "schema: spec-driven\n");
  await writeFile(join(changeRoot, "proposal.md"), "# Предложение\n");
  await git("add", ".");
  await git("commit", "-m", "docs(openspec): add change");
  const baseline = await git("rev-parse", "HEAD");
  await execFileAsync("git", ["init", "--bare", join(root, "origin.git")]);
  await git("remote", "add", "origin", join(root, "origin.git"));
  await git("push", "-u", "origin", branch);
  let prState = "OPEN";
  const calls = [];
  const command = async (executable, args, options = {}) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "mise") {
      return { stdout: JSON.stringify({ changeName: changeId, changeRoot,
        actionContext: { mode: "repo-local", sourceOfTruth: "repo" } }), stderr: "" };
    }
    if (executable === "git" && args.join(" ") === "remote get-url origin") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (executable === "gh" && args[0] === "auth") return { stdout: "", stderr: "" };
    if (executable === "gh" && args[0] === "repo") {
      return { stdout: JSON.stringify({ nameWithOwner: "example/project", url: repositoryUrl }), stderr: "" };
    }
    if (executable === "gh" && args[0] === "pr" && ["list", "view"].includes(args[1])) {
      const remote = await git("ls-remote", "--heads", "origin", `refs/heads/${branch}`);
      const pr = { number: 41, url: `${repositoryUrl}/pull/41`, state: prState,
        isDraft: true, isCrossRepository: false, baseRefName: "main", headRefName: branch,
        headRefOid: remote.split(/\s/u)[0], title: "Change", body: "Описание" };
      return { stdout: JSON.stringify(args[1] === "list" ? [pr] : pr), stderr: "" };
    }
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd, signal: options.signal, env: { ...process.env, ...options.env },
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
  return { workspace, changeRoot, baseline, git, command, calls,
    merge: () => { prState = "MERGED"; } };
}

test("review-коммит публикуется в корневой Draft PR и восстанавливается после push", async (context) => {
  const value = await fixture(context);
  const target = await prepareReviewPublication(value.workspace, changeId, branch, branch, undefined, value.command);
  assert.equal(target.parentBaselineCommit, value.baseline);
  assert.equal(target.baselineCommit, value.baseline);
  await writeFile(join(value.changeRoot, "review.md"), "# Review\n\nПроблем не найдено.\n");
  await value.git("add", ".");
  await value.git("commit", "-m", reviewCommitSubject(changeId));
  const verification = createChangeReviewVerification({ command: value.command });
  const reviewContext = await verification.readContext(value.workspace, changeId);
  const session = { ...target, changeId, phaseNumber: null };
  const first = await verification.verifyCompleted(reviewContext, session, new AbortController().signal);
  const second = await verification.verifyCompleted(reviewContext, session, new AbortController().signal);
  assert.equal(first.pullRequest.number, 41);
  assert.deepEqual(second, first);
  assert.equal(value.calls.filter((call) => call.startsWith("git push ")).length, 1);
  assert.equal(value.calls.some((call) => call.includes("gh pr create") || call.includes("git switch -c")), false);
});

test("review отклоняет незапланированное изменение и преждевременный merge", async (context) => {
  const value = await fixture(context);
  const target = await prepareReviewPublication(value.workspace, changeId, branch, branch, undefined, value.command);
  value.merge();
  await assert.rejects(prepareReviewPublication(value.workspace, changeId, branch, branch, undefined, value.command));
  await writeFile(join(value.changeRoot, "review.md"), "# Review\n");
  await writeFile(join(value.changeRoot, "proposal.md"), "# Незапланированное изменение\n");
  await value.git("add", ".");
  await value.git("commit", "-m", reviewCommitSubject(changeId));
  const verification = createChangeReviewVerification({ command: value.command });
  const reviewContext = await verification.readContext(value.workspace, changeId);
  await assert.rejects(
    verification.verifyCompleted(reviewContext, { ...target, changeId, phaseNumber: null }, new AbortController().signal),
    /только|недопуст|proposal|измен/u,
  );
});

test("review prompt запрещает агенту ветки, PR и push", () => {
  const session = {
    changeId, phaseNumber: null, parentBranch: branch, reviewBranch: branch,
    parentBaselineCommit: "a".repeat(40), baselineCommit: "a".repeat(40),
    repositoryHost: "github.com", repositoryNameWithOwner: "example/project",
    repositoryUrl, parentPullRequestNumber: 41,
  };
  const prompt = changeReviewPrompt({
    ...session, repository: "example/project",
    reviewRepositoryPath: `openspec/changes/${changeId}/review.md`,
    alreadyCommitted: false,
  });
  assert.match(prompt, /Never invoke `gh`/u);
  assert.match(prompt, /Do not push/u);
  assert.match(prompt, /change\/complete-review-workflow/u);
});
