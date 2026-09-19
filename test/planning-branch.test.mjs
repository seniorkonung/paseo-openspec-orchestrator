import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  PlanningBranchError,
  createPlanningBranchService,
} from "../server/planning-branch.ts";

const execFileAsync = promisify(execFile);
const changeId = "planning-contract";
const changeBranch = `change/${changeId}`;
const planningBranch = `planning/${changeId}/initial`;

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return String(result.stdout).trim();
}

async function repository(context) {
  const root = await mkdtemp(join(tmpdir(), "planning-branch-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const remote = join(root, "origin.git");
  await mkdir(workspace);
  await git(workspace, ["init", "-b", changeBranch]);
  await git(workspace, ["config", "user.name", "OpenSpec Test"]);
  await git(workspace, ["config", "user.email", "openspec@example.test"]);
  await writeFile(join(workspace, "README.md"), "# Test\n");
  await git(workspace, ["add", "README.md"]);
  await git(workspace, ["commit", "-m", "docs: initialize repository"]);
  const baselineCommit = await git(workspace, ["rev-parse", "HEAD"]);
  await git(root, ["init", "--bare", remote]);
  await git(workspace, ["remote", "add", "origin", remote]);
  await git(workspace, ["push", "--set-upstream", "origin", changeBranch]);
  return { workspace, baselineCommit, historicalPullRequests: [] };
}

function commandFor(fixture) {
  return async (executable, args, options = {}) => {
    if (executable === "git" && args[0] === "remote" && args[1] === "get-url") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (executable === "gh" && args[0] === "auth") {
      return { stdout: "", stderr: "" };
    }
    if (executable === "gh" && args[0] === "repo") {
      return {
        stdout: JSON.stringify({
          nameWithOwner: "example/project",
          url: "https://github.com/example/project",
        }),
        stderr: "",
      };
    }
    if (executable === "gh" && args[0] === "pr" && args[1] === "list") {
      return {
        stdout: JSON.stringify(fixture.historicalPullRequests),
        stderr: "",
      };
    }
    const result = await execFileAsync(executable, [...args], {
      cwd: options.cwd,
      signal: options.signal,
      encoding: "utf8",
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
}

test("создаёт planning/<id>/initial строго от сохранённого root baseline и восстанавливается", async (context) => {
  const fixture = await repository(context);
  const service = createPlanningBranchService({ command: commandFor(fixture) });
  const session = await service.prepare(
    fixture.workspace,
    changeId,
    changeBranch,
  );
  assert.deepEqual(session, {
    changeId,
    changeBranch,
    planningBranch,
    baselineCommit: fixture.baselineCommit,
  });
  assert.equal(await service.activate(fixture.workspace, session), planningBranch);
  assert.equal(await git(fixture.workspace, ["branch", "--show-current"]), planningBranch);
  assert.equal(await git(fixture.workspace, ["rev-parse", "HEAD"]), fixture.baselineCommit);
  assert.equal(await service.activate(fixture.workspace, session), planningBranch);
});

test("отклоняет занятый local ref и исторический pull request", async (context) => {
  await context.test("local ref", async (child) => {
    const fixture = await repository(child);
    await git(fixture.workspace, ["branch", planningBranch]);
    const service = createPlanningBranchService({ command: commandFor(fixture) });
    await assert.rejects(
      service.prepare(fixture.workspace, changeId, changeBranch),
      /уже существует/,
    );
  });
  await context.test("historical PR", async (child) => {
    const fixture = await repository(child);
    fixture.historicalPullRequests = [{
      number: 7,
      url: "https://github.com/example/project/pull/7",
      state: "CLOSED",
      isDraft: false,
      isCrossRepository: false,
      baseRefName: changeBranch,
      headRefName: planningBranch,
      headRefOid: fixture.baselineCommit,
      title: "Закрытый PR",
      body: "Закрыт",
    }];
    const service = createPlanningBranchService({ command: commandFor(fixture) });
    await assert.rejects(
      service.prepare(fixture.workspace, changeId, changeBranch),
      PlanningBranchError,
    );
  });
  await context.test("PR appeared after prepare", async (child) => {
    const fixture = await repository(child);
    const service = createPlanningBranchService({ command: commandFor(fixture) });
    const session = await service.prepare(
      fixture.workspace,
      changeId,
      changeBranch,
    );
    fixture.historicalPullRequests = [{
      number: 8,
      url: "https://github.com/example/project/pull/8",
      state: "OPEN",
      isDraft: false,
      isCrossRepository: false,
      baseRefName: changeBranch,
      headRefName: planningBranch,
      headRefOid: fixture.baselineCommit,
      title: "Неожиданный PR",
      body: "Создан конкурентно",
    }];
    await assert.rejects(
      service.activate(fixture.workspace, session),
      /неожиданно появился pull request/,
    );
    assert.equal(
      await git(fixture.workspace, ["branch", "--show-current"]),
      changeBranch,
    );
  });
});
