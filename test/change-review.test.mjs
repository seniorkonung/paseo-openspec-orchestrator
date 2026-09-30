import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { prepareReviewPublication } from "../server/change-review-publication.ts";
import { createChangeReviewVerification } from "../server/change-review-verification.ts";
import { ChangeReviewError, changeReviewPrompt } from "../server/change-review.ts";

const execFileAsync = promisify(execFile);
const changeId = "complete-review-workflow";
const branch = `change/${changeId}`;
const repositoryUrl = "https://github.com/example/project";
const reviewSubject = "Review report";
// Область задач review проверяется отдельно; здесь её нарушений нет.
const withinTaskScope = async () => {};

async function fixture(context, { existingReview = false } = {}) {
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
  await writeFile(join(workspace, "implementation.ts"), "export const implemented = false;\n");
  if (existingReview) await writeFile(join(changeRoot, "review.md"), "# Предыдущий review\n");
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
        mergeCommit: prState === "MERGED" ? { oid: baseline } : null,
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

test("review публикует отчёт с правками артефактов и кода и восстанавливается после push", async (context) => {
  const value = await fixture(context);
  const target = await prepareReviewPublication(value.workspace, changeId, branch, branch, undefined, value.command);
  assert.equal(target.parentBaselineCommit, value.baseline);
  assert.equal(target.baselineCommit, value.baseline);
  await writeFile(join(value.changeRoot, "review.md"), "# Review\n\nПроблем не найдено.\n");
  await writeFile(join(value.changeRoot, "proposal.md"), "# Уточнённое предложение\n");
  await writeFile(join(value.workspace, "implementation.ts"), "export const implemented = true;\n");
  await value.git("add", ".");
  await value.git("commit", "-m", reviewSubject);
  const verification = createChangeReviewVerification({ command: value.command });
  const reviewContext = await verification.readContext(value.workspace, changeId);
  const session = { ...target, changeId, phaseNumber: null };
  assert.equal(await verification.isLocalCommitReady(reviewContext, session, withinTaskScope, new AbortController().signal), true);
  const first = await verification.verifyCompleted(reviewContext, session, withinTaskScope, new AbortController().signal);
  const second = await verification.verifyCompleted(reviewContext, session, withinTaskScope, new AbortController().signal);
  assert.equal(first.pullRequest.number, 41);
  assert.deepEqual(second, first);
  assert.equal(value.calls.filter((call) => call.startsWith("git push ")).length, 1);
  assert.equal(value.calls.some((call) => call.includes("gh pr create") || call.includes("git switch -c")), false);
  assert.equal(await value.git("show", "HEAD:implementation.ts"), "export const implemented = true;");
});

test("review публикует несколько коммитов с произвольными сообщениями", async (context) => {
  const value = await fixture(context);
  const target = await prepareReviewPublication(value.workspace, changeId, branch, branch, undefined, value.command);
  await writeFile(join(value.changeRoot, "review.md"), "# Review\n\nПервый проход.\n");
  await value.git("add", ".");
  await value.git("commit", "-m", "Первый проход");
  await writeFile(join(value.changeRoot, "review.md"), "# Review\n\nПроблем не найдено.\n");
  await value.git("add", ".");
  await value.git("commit", "-m", "Дополнительная проверка");
  const verification = createChangeReviewVerification({ command: value.command });
  const reviewContext = await verification.readContext(value.workspace, changeId);
  const session = { ...target, changeId, phaseNumber: null };
  const result = await verification.verifyCompleted(reviewContext, session, withinTaskScope, new AbortController().signal);
  assert.equal(result.pullRequest.number, 41);
  assert.match(
    await value.git("ls-remote", "--heads", "origin", `refs/heads/${branch}`),
    new RegExp(`^${await value.git("rev-parse", "HEAD")}`, "u"),
  );
  assert.equal(await value.git("rev-list", "--count", `${value.baseline}..HEAD`), "2");
  assert.equal(value.calls.filter((call) => call.startsWith("git push ")).length, 1);
});

test("review с правками отклоняет преждевременный merge", async (context) => {
  const value = await fixture(context);
  const target = await prepareReviewPublication(value.workspace, changeId, branch, branch, undefined, value.command);
  value.merge();
  await assert.rejects(prepareReviewPublication(value.workspace, changeId, branch, branch, undefined, value.command));
  await writeFile(join(value.changeRoot, "review.md"), "# Review\n");
  await writeFile(join(value.changeRoot, "proposal.md"), "# Незапланированное изменение\n");
  await value.git("add", ".");
  await value.git("commit", "-m", reviewSubject);
  const verification = createChangeReviewVerification({ command: value.command });
  const reviewContext = await verification.readContext(value.workspace, changeId);
  await assert.rejects(
    verification.verifyCompleted(reviewContext, { ...target, changeId, phaseNumber: null }, withinTaskScope, new AbortController().signal),
    /Корневой PR/u,
  );
  assert.equal(value.calls.some((call) => call.startsWith("git push ")), false);
});

test("review требует обновлённый отчёт даже при закоммиченных правках кода", async (context) => {
  for (const report of ["отсутствует", "не изменён", "удалён"]) {
    await context.test(report, async (subcontext) => {
      const value = await fixture(subcontext, { existingReview: report !== "отсутствует" });
      const target = await prepareReviewPublication(value.workspace, changeId, branch, branch, undefined, value.command);
      await writeFile(join(value.workspace, "implementation.ts"), "export const implemented = true;\n");
      if (report === "удалён") await rm(join(value.changeRoot, "review.md"));
      await value.git("add", ".");
      await value.git("commit", "-m", "fix(review): correct implementation");
      const verification = createChangeReviewVerification({ command: value.command });
      const reviewContext = await verification.readContext(value.workspace, changeId);
      const session = { ...target, changeId, phaseNumber: null };
      const signal = new AbortController().signal;
      assert.equal(await verification.isLocalCommitReady(reviewContext, session, withinTaskScope, signal), false);
      await assert.rejects(verification.verifyCompleted(reviewContext, session, withinTaskScope, signal), /review\.md/u);
      assert.equal(value.calls.some((call) => call.startsWith("git push ")), false);
    });
  }
});

test("review prompt разрешает правки и сохраняет запрет на ветки, PR и push", () => {
  const session = {
    changeId, phaseNumber: null, parentBranch: branch, reviewBranch: branch,
    parentBaselineCommit: "a".repeat(40), baselineCommit: "a".repeat(40),
    repositoryHost: "github.com", repositoryNameWithOwner: "example/project",
    repositoryUrl, parentPullRequestNumber: 41,
  };
  for (const phaseNumber of [null, 2]) {
    const prompt = changeReviewPrompt({
      ...session, phaseNumber, repository: "example/project",
      reviewRepositoryPath: `openspec/changes/${changeId}/review.md`,
      alreadyCommitted: false,
      taskScope: phaseNumber === null
        ? { kind: "initial-planning", plannedPhases: [1] }
        : { kind: "phase-planning", phaseNumber },
    });
    assert.match(prompt, /Never invoke `gh`/u);
    assert.match(prompt, /Do not push/u);
    assert.match(prompt, /change\/complete-review-workflow/u);
    assert.match(prompt, /Follow the review skill/u);
    assert.doesNotMatch(prompt, /never fix findings|Leave every other pre-existing file|commit only those files/u);
    if (phaseNumber !== null) assert.match(prompt, /Phase 2/u);
    assert.match(
      prompt,
      phaseNumber === null
        ? /Add new tasks only to phases that already have tasks: Phase 1\./u
        : /Add new tasks only to Phase 2\./u,
    );
    assert.match(prompt, /The orchestrator plans every phase that has no tasks/u);
  }
});

test("review не публикует коммит, который наполняет задачами фазу оркестратора", async (context) => {
  const value = await fixture(context);
  const target = await prepareReviewPublication(value.workspace, changeId, branch, branch, undefined, value.command);
  await writeFile(join(value.changeRoot, "review.md"), "# Review\n\nДобавлена задача следующей фазы.\n");
  await value.git("add", ".");
  await value.git("commit", "-m", reviewSubject);
  const verification = createChangeReviewVerification({ command: value.command });
  const reviewContext = await verification.readContext(value.workspace, changeId);
  const session = { ...target, changeId, phaseNumber: null };
  const signal = new AbortController().signal;
  const scopeChecks = [];
  const violatesTaskScope = async (checkSignal) => {
    scopeChecks.push(checkSignal);
    throw new ChangeReviewError("Задачи 2.1 нарушают это правило");
  };

  assert.equal(await verification.isLocalCommitReady(reviewContext, session, violatesTaskScope, signal), false);
  await assert.rejects(
    verification.verifyCompleted(reviewContext, session, violatesTaskScope, signal),
    /Задачи 2\.1 нарушают это правило/u,
  );
  assert.deepEqual(scopeChecks, [signal, signal]);
  assert.equal(value.calls.some((call) => call.startsWith("git push ")), false);
});
