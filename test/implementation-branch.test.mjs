import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createImplementationBranchService } from "../server/implementation-branch.ts";
import { createImplementationRunVerifier } from "../server/implementation-run-verification.ts";

const execFileAsync = promisify(execFile);
const changeId = "implementation-cycle";
const changeBranch = `change/${changeId}`;
const implementationBranch = `implementation/${changeId}/phase-1/run-1`;

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "implementation-branch-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const remote = join(root, "origin.git");
  await mkdir(workspace);
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["init", "-b", changeBranch], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "OpenSpec Test"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "openspec@example.test"], { cwd: workspace });
  await writeFile(join(workspace, "README.md"), "root\n");
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "docs: add root"], { cwd: workspace });
  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: workspace });
  await execFileAsync("git", ["push", "-u", "origin", changeBranch], { cwd: workspace });
  let historical = [];
  const command = async (executable, arguments_, options) => {
    if (executable === "git" && arguments_.join(" ") === "remote get-url origin") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (executable === "gh" && arguments_[0] === "auth") return { stdout: "", stderr: "" };
    if (executable === "gh" && arguments_[0] === "repo") {
      return { stdout: JSON.stringify({ nameWithOwner: "example/project", url: "https://github.com/example/project" }), stderr: "" };
    }
    if (executable === "gh" && arguments_[0] === "pr" && arguments_[1] === "list") {
      return { stdout: JSON.stringify(historical), stderr: "" };
    }
    const result = await execFileAsync(executable, arguments_, {
      cwd: options.cwd,
      signal: options.signal,
      encoding: "utf8",
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
  return { workspace, baseline, command, setHistorical: (value) => { historical = value; } };
}

test("создаёт implementation/<id>/phase-N/run-M строго от root baseline", async (context) => {
  const value = await fixture(context);
  const service = createImplementationBranchService({ command: value.command });
  const session = await service.prepare(value.workspace, changeId, changeBranch);
  assert.equal(session.implementationBranch, implementationBranch);
  assert.equal(session.rootBaselineCommit, value.baseline);
  const run = await service.activate(value.workspace, session);
  assert.equal(run.implementationBranch, implementationBranch);
  assert.deepEqual(run.publication, { kind: "unpublished" });
  assert.deepEqual(run.batch, { kind: "empty", baseCommit: value.baseline });
  const current = (await execFileAsync("git", ["branch", "--show-current"], { cwd: value.workspace })).stdout.trim();
  assert.equal(current, implementationBranch);
});

test("prepare отклоняет local ref и исторический PR implementation-ветки", async (context) => {
  const local = await fixture(context);
  await execFileAsync("git", ["branch", implementationBranch, local.baseline], { cwd: local.workspace });
  await assert.rejects(
    createImplementationBranchService({ command: local.command }).prepare(local.workspace, changeId, changeBranch),
    /уже существует/u,
  );

  const historical = await fixture(context);
  historical.setHistorical([{
    number: 7,
    url: "https://github.com/example/project/pull/7",
    state: "CLOSED",
    isDraft: false,
    isCrossRepository: false,
    baseRefName: changeBranch,
    headRefName: implementationBranch,
    headRefOid: historical.baseline,
    title: "старый",
    body: "старый PR",
  }]);
  await assert.rejects(
    createImplementationBranchService({ command: historical.command }).prepare(historical.workspace, changeId, changeBranch),
    /уже существует pull request/u,
  );
});

test("activate fail-closed замечает root drift после durable prepare", async (context) => {
  const value = await fixture(context);
  const service = createImplementationBranchService({ command: value.command });
  const session = await service.prepare(value.workspace, changeId, changeBranch);
  await writeFile(join(value.workspace, "README.md"), "drift\n");
  await execFileAsync("git", ["add", "."], { cwd: value.workspace });
  await execFileAsync("git", ["commit", "-m", "docs: drift root"], { cwd: value.workspace });
  await execFileAsync("git", ["push", "origin", changeBranch], { cwd: value.workspace });
  await assert.rejects(service.activate(value.workspace, session), /изменилась/u);
});

test("run verifier подтверждает общий remote head и неизменный root baseline", async (context) => {
  const value = await fixture(context);
  const branchService = createImplementationBranchService({ command: value.command });
  const session = await branchService.prepare(value.workspace, changeId, changeBranch);
  const run = await branchService.activate(value.workspace, session);
  await execFileAsync("git", ["push", "-u", "origin", implementationBranch], {
    cwd: value.workspace,
  });

  const head = await createImplementationRunVerifier({ command: value.command }).assertCurrent(
    value.workspace,
    run,
  );
  assert.equal(head, value.baseline);
});

test("run verifier fail-closed замечает drift root-ветки между resolver-циклами", async (context) => {
  const value = await fixture(context);
  const branchService = createImplementationBranchService({ command: value.command });
  const session = await branchService.prepare(value.workspace, changeId, changeBranch);
  const run = await branchService.activate(value.workspace, session);
  await execFileAsync("git", ["push", "-u", "origin", implementationBranch], {
    cwd: value.workspace,
  });
  await writeFile(join(value.workspace, "implementation.txt"), "drift\n");
  await execFileAsync("git", ["add", "."], { cwd: value.workspace });
  await execFileAsync("git", ["commit", "-m", "test: create drift commit"], {
    cwd: value.workspace,
  });
  await execFileAsync("git", ["branch", "-f", changeBranch, "HEAD"], {
    cwd: value.workspace,
  });
  await execFileAsync("git", ["push", "--force", "origin", changeBranch], {
    cwd: value.workspace,
  });
  await execFileAsync("git", ["reset", "--hard", value.baseline], { cwd: value.workspace });
  await execFileAsync("git", ["push", "--force", "origin", implementationBranch], {
    cwd: value.workspace,
  });

  await assert.rejects(
    createImplementationRunVerifier({ command: value.command }).assertCurrent(
      value.workspace,
      run,
    ),
    /Root baseline/u,
  );
});
