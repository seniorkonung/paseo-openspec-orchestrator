import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  PlanningMergeError,
  createPlanningMergeService,
} from "../server/planning-merge.ts";

const execFileAsync = promisify(execFile);
const changeId = "merge-planning";
const changeBranch = `change/${changeId}`;
const planningBranch = `planning/${changeId}/initial`;
const repositoryUrl = "https://github.com/example/project";

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return String(result.stdout).trim();
}

async function repository(context) {
  const root = await mkdtemp(join(tmpdir(), "planning-merge-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const remote = join(root, "origin.git");
  await mkdir(workspace);
  await git(workspace, ["init", "-b", changeBranch]);
  await git(workspace, ["config", "user.name", "OpenSpec Test"]);
  await git(workspace, ["config", "user.email", "openspec@example.test"]);
  await writeFile(join(workspace, "root.txt"), "root\n");
  await git(workspace, ["add", "root.txt"]);
  await git(workspace, ["commit", "-m", "docs: root"]);
  const rootHead = await git(workspace, ["rev-parse", "HEAD"]);
  await git(root, ["init", "--bare", remote]);
  await git(workspace, ["remote", "add", "origin", remote]);
  await git(workspace, ["push", "--set-upstream", "origin", changeBranch]);
  await git(workspace, ["switch", "-c", planningBranch]);
  await writeFile(join(workspace, "planning.txt"), "planning\n");
  await git(workspace, ["add", "planning.txt"]);
  await git(workspace, ["commit", "-m", "docs: planning"]);
  const planningHead = await git(workspace, ["rev-parse", "HEAD"]);
  await git(workspace, ["push", "--set-upstream", "origin", planningBranch]);
  const fixture = {
    workspace,
    rootHead,
    planningHead,
    pullRequest: {
      number: 43,
      url: `${repositoryUrl}/pull/43`,
      state: "OPEN",
      isDraft: false,
      isCrossRepository: false,
      baseRefName: changeBranch,
      headRefName: planningBranch,
      headRefOid: planningHead,
      title: "Первичное ревью OpenSpec change",
      body: "Planning готов к merge.",
    },
  };
  return fixture;
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
          url: repositoryUrl,
        }),
        stderr: "",
      };
    }
    if (executable === "gh" && args[0] === "pr" && args[1] === "list") {
      return {
        stdout: JSON.stringify(fixture.pullRequests ?? [fixture.pullRequest]),
        stderr: "",
      };
    }
    if (executable === "gh" && args[0] === "pr" && args[1] === "view") {
      const pullRequest = (fixture.pullRequests ?? [fixture.pullRequest]).find(
        ({ number }) => number === Number(args[2]),
      );
      if (!pullRequest) throw new Error("PR not found");
      return { stdout: JSON.stringify(pullRequest), stderr: "" };
    }
    const result = await execFileAsync(executable, [...args], {
      cwd: options.cwd,
      signal: options.signal,
      encoding: "utf8",
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
}

test("OPEN planning PR возвращает recoverable ожидание", async (context) => {
  const fixture = await repository(context);
  const service = createPlanningMergeService({ command: commandFor(fixture) });
  assert.deepEqual(
    await service.inspect(
      fixture.workspace,
      changeId,
      changeBranch,
      planningBranch,
    ),
    {
      kind: "open",
      pullRequest: { number: 43, url: `${repositoryUrl}/pull/43` },
    },
  );
});

test("MERGED planning PR переключает root и обновляет её только fast-forward", async (context) => {
  const fixture = await repository(context);
  await git(fixture.workspace, ["push", "origin", `${planningBranch}:${changeBranch}`]);
  fixture.pullRequest.state = "MERGED";
  const service = createPlanningMergeService({ command: commandFor(fixture) });
  const inspected = await service.inspect(
    fixture.workspace,
    changeId,
    changeBranch,
    planningBranch,
  );
  assert.equal(inspected.kind, "merged");
  assert.equal(inspected.session.mergedPlanningHead, fixture.planningHead);

  assert.equal(
    await service.complete(fixture.workspace, inspected.session),
    changeBranch,
  );
  assert.equal(await git(fixture.workspace, ["branch", "--show-current"]), changeBranch);
  assert.equal(await git(fixture.workspace, ["rev-parse", "HEAD"]), fixture.planningHead);
  assert.equal(
    await service.complete(fixture.workspace, inspected.session),
    changeBranch,
  );
});

test("merge-gate отклоняет CLOSED, неверные refs и dirty worktree", async (context) => {
  await context.test("closed without merge", async (child) => {
    const fixture = await repository(child);
    fixture.pullRequest.state = "CLOSED";
    const service = createPlanningMergeService({ command: commandFor(fixture) });
    await assert.rejects(
      service.inspect(fixture.workspace, changeId, changeBranch, planningBranch),
      /закрыт без merge/,
    );
  });
  await context.test("wrong base", async (child) => {
    const fixture = await repository(child);
    fixture.pullRequest.baseRefName = "main";
    const service = createPlanningMergeService({ command: commandFor(fixture) });
    await assert.rejects(
      service.inspect(fixture.workspace, changeId, changeBranch, planningBranch),
      PlanningMergeError,
    );
  });
  await context.test("wrong head", async (child) => {
    const fixture = await repository(child);
    fixture.pullRequest.headRefName = "planning/other-change/initial";
    const service = createPlanningMergeService({ command: commandFor(fixture) });
    await assert.rejects(
      service.inspect(fixture.workspace, changeId, changeBranch, planningBranch),
      PlanningMergeError,
    );
  });
  await context.test("cross repository", async (child) => {
    const fixture = await repository(child);
    fixture.pullRequest.isCrossRepository = true;
    const service = createPlanningMergeService({ command: commandFor(fixture) });
    await assert.rejects(
      service.inspect(fixture.workspace, changeId, changeBranch, planningBranch),
      PlanningMergeError,
    );
  });
  await context.test("duplicate PR", async (child) => {
    const fixture = await repository(child);
    fixture.pullRequests = [
      fixture.pullRequest,
      { ...fixture.pullRequest, number: 44, url: `${repositoryUrl}/pull/44` },
    ];
    const service = createPlanningMergeService({ command: commandFor(fixture) });
    await assert.rejects(
      service.inspect(fixture.workspace, changeId, changeBranch, planningBranch),
      /ровно один pull request/,
    );
  });
  await context.test("dirty", async (child) => {
    const fixture = await repository(child);
    await writeFile(join(fixture.workspace, "dirty.txt"), "dirty\n");
    const service = createPlanningMergeService({ command: commandFor(fixture) });
    await assert.rejects(
      service.inspect(fixture.workspace, changeId, changeBranch, planningBranch),
      /незакоммиченные или неотслеживаемые/,
    );
  });
});

test("merge-gate не переписывает расходящуюся локальную root-ветку", async (context) => {
  const fixture = await repository(context);
  await git(fixture.workspace, ["switch", changeBranch]);
  await writeFile(join(fixture.workspace, "local-root.txt"), "local root\n");
  await git(fixture.workspace, ["add", "local-root.txt"]);
  await git(fixture.workspace, ["commit", "-m", "docs: local root divergence"]);
  await git(fixture.workspace, ["switch", planningBranch]);
  await git(fixture.workspace, ["push", "origin", `${planningBranch}:${changeBranch}`]);
  fixture.pullRequest.state = "MERGED";
  const service = createPlanningMergeService({ command: commandFor(fixture) });
  const inspected = await service.inspect(
    fixture.workspace,
    changeId,
    changeBranch,
    planningBranch,
  );
  assert.equal(inspected.kind, "merged");
  await assert.rejects(
    service.complete(fixture.workspace, inspected.session),
    /невозможно обновить fast-forward/,
  );
});
