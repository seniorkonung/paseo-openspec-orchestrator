import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  ChangeInitializationError,
  changeCommitSubject,
  createChangeInitializationService,
  initialPullRequestBody,
  initialPullRequestTitle,
} from "../server/change-initialization.ts";

const execFileAsync = promisify(execFile);
const changeId = "branch-owned-change";
const changeBranch = `change/${changeId}`;
const repositoryUrl = "https://github.com/example/project";

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return String(result.stdout).trim();
}

async function repository(context, { existing = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "change-initialization-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const remote = join(root, "origin.git");
  const changeRoot = join(workspace, "openspec", "changes", changeId);
  await mkdir(workspace);
  await git(workspace, ["init", "-b", changeBranch]);
  await git(workspace, ["config", "user.name", "OpenSpec Test"]);
  await git(workspace, ["config", "user.email", "openspec@example.test"]);
  await writeFile(join(workspace, "README.md"), "# Test\n");
  if (existing) {
    await mkdir(changeRoot, { recursive: true });
    await writeFile(join(changeRoot, ".openspec.yaml"), "schema: spec-driven\n");
    await writeFile(join(changeRoot, "proposal.md"), "# Existing\n");
  }
  await git(workspace, ["add", "."]);
  await git(workspace, ["commit", "-m", "docs: initialize repository"]);
  const baselineCommit = await git(workspace, ["rev-parse", "HEAD"]);
  await git(root, ["init", "--bare", remote]);
  await git(workspace, ["remote", "add", "origin", remote]);
  await git(workspace, ["push", "origin", "HEAD:refs/heads/main"]);
  await git(workspace, ["push", "--set-upstream", "origin", changeBranch]);
  return {
    root,
    workspace,
    remote,
    changeRoot,
    baselineCommit,
    changeExists: existing,
    pullRequests: [],
    newCalls: 0,
    pushFailures: 0,
    createPullRequestFailuresAfterEffect: 0,
    addForeignPath: false,
    invalidNewJson: false,
    invalidListJson: false,
    invalidStatusJson: false,
    createdPathOverride: null,
    rootOutputPath: workspace,
    updateCalls: 0,
  };
}

function commandFor(fixture) {
  return async (executable, args, options = {}) => {
    if (executable === "mise") {
      const openspecArgs = args.slice(4);
      if (openspecArgs[0] === "list") {
        if (fixture.invalidListJson) return { stdout: "{}", stderr: "" };
        return {
          stdout: JSON.stringify({
            changes: fixture.changeExists ? [{ name: changeId }] : [],
            root: { path: fixture.rootOutputPath, source: "nearest" },
          }),
          stderr: "",
        };
      }
      if (openspecArgs[0] === "new") {
        fixture.newCalls += 1;
        if (fixture.invalidNewJson) return { stdout: "{}", stderr: "" };
        await mkdir(fixture.changeRoot, { recursive: true });
        await writeFile(
          join(fixture.changeRoot, ".openspec.yaml"),
          "schema: spec-driven\n",
        );
        if (fixture.addForeignPath) {
          await writeFile(join(fixture.workspace, "foreign.txt"), "foreign\n");
        }
        fixture.changeExists = true;
        return {
          stdout: JSON.stringify({
            change: {
              id: changeId,
              path:
                fixture.createdPathOverride ??
                `openspec/changes/${changeId}`,
              metadataPath: `openspec/changes/${changeId}/.openspec.yaml`,
              schema: "spec-driven",
            },
            root: { path: fixture.rootOutputPath, source: "nearest" },
          }),
          stderr: "",
        };
      }
      if (openspecArgs[0] === "status") {
        if (fixture.invalidStatusJson) return { stdout: "{}", stderr: "" };
        return {
          stdout: JSON.stringify({
            changeName: changeId,
            changeRoot: fixture.changeRoot,
            actionContext: { mode: "repo-local", sourceOfTruth: "repo" },
            root: { path: fixture.rootOutputPath, source: "nearest" },
          }),
          stderr: "",
        };
      }
      throw new Error(`Неожиданный OpenSpec вызов: ${openspecArgs.join(" ")}`);
    }
    if (executable === "git" && args[0] === "remote" && args[1] === "get-url") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (executable === "git" && args[0] === "push" && fixture.pushFailures > 0) {
      fixture.pushFailures -= 1;
      throw new Error("push interrupted");
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
        stdout: JSON.stringify(
          fixture.pullRequests.filter(({ state }) => state === "OPEN"),
        ),
        stderr: "",
      };
    }
    if (executable === "gh" && args[0] === "pr" && args[1] === "create") {
      const remoteHead = (
        await execFileAsync(
          "git",
          ["ls-remote", "--heads", fixture.remote, `refs/heads/${changeBranch}`],
          { encoding: "utf8" },
        )
      ).stdout.toString().trim().split(/\s+/u)[0];
      fixture.pullRequests = [{
        number: 41,
        url: `${repositoryUrl}/pull/41`,
        state: "OPEN",
        isDraft: args.includes("--draft"),
        isCrossRepository: false,
        baseRefName: args[args.indexOf("--base") + 1],
        headRefName: args[args.indexOf("--head") + 1],
        headRefOid: remoteHead,
        title: args[args.indexOf("--title") + 1],
        body: args[args.indexOf("--body") + 1],
      }];
      if (fixture.createPullRequestFailuresAfterEffect > 0) {
        fixture.createPullRequestFailuresAfterEffect -= 1;
        throw new Error("response interrupted after PR creation");
      }
      return { stdout: `${repositoryUrl}/pull/41\n`, stderr: "" };
    }
    if (executable === "gh" && args[0] === "pr" && args[1] === "view") {
      const number = Number(args[2]);
      const pullRequest = fixture.pullRequests.find((candidate) => candidate.number === number);
      if (!pullRequest) throw new Error("PR not found");
      return { stdout: JSON.stringify(pullRequest), stderr: "" };
    }
    if (executable === "gh" && args[0] === "api") {
      fixture.updateCalls += 1;
      const requestPath = args[args.indexOf("--input") + 1];
      const update = JSON.parse(await readFile(requestPath, "utf8"));
      const number = Number(args.find((argument) => argument.startsWith("repos/"))?.split("/").at(-1));
      const pullRequest = fixture.pullRequests.find(
        (candidate) => candidate.number === number,
      );
      pullRequest.baseRefName = update.base;
      return { stdout: "", stderr: "" };
    }
    const result = await execFileAsync(executable, [...args], {
      cwd: options.cwd,
      signal: options.signal,
      encoding: "utf8",
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
}

test("создаёт новый change, отдельный scaffold-коммит, push и Draft root PR", async (context) => {
  const fixture = await repository(context);
  const service = createChangeInitializationService({ command: commandFor(fixture) });
  const session = await service.prepare(fixture.workspace, changeId, changeBranch);
  assert.deepEqual(session, {
    changeId,
    changeBranch,
    baselineCommit: fixture.baselineCommit,
    changeExisted: false,
    openSpecRoot: fixture.workspace,
    existingRootPullRequest: null,
  });
  const initialized = await service.initialize(fixture.workspace, session);
  assert.deepEqual(initialized, {
    change: { id: changeId },
    changeBranch,
    pullRequest: { number: 41, url: `${repositoryUrl}/pull/41` },
  });
  assert.equal(fixture.newCalls, 1);
  assert.equal(
    await git(fixture.workspace, ["show", "-s", "--format=%s", "HEAD"]),
    changeCommitSubject(changeId),
  );
  assert.equal(fixture.pullRequests[0].isDraft, true);
  assert.equal(fixture.pullRequests[0].title, initialPullRequestTitle(changeId));
  assert.equal(fixture.pullRequests[0].body, initialPullRequestBody(changeId));
  assert.equal(fixture.pullRequests[0].baseRefName, "main");
});

test("существующий change не пересоздаётся, а Ready root PR сохраняет статус", async (context) => {
  const fixture = await repository(context, { existing: true });
  fixture.pullRequests = [{
    number: 9,
    url: `${repositoryUrl}/pull/9`,
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    baseRefName: "develop",
    headRefName: changeBranch,
    headRefOid: fixture.baselineCommit,
    title: "Существующий PR",
    body: "Существующее описание",
  }];
  const service = createChangeInitializationService({ command: commandFor(fixture) });
  const session = await service.prepare(fixture.workspace, changeId, changeBranch);
  const initialized = await service.initialize(fixture.workspace, session);
  assert.equal(initialized.pullRequest.number, 9);
  assert.equal(fixture.newCalls, 0);
  assert.equal(fixture.pullRequests[0].baseRefName, "main");
  assert.equal(fixture.pullRequests[0].isDraft, false);
  assert.equal(fixture.updateCalls, 1);
  assert.equal(await git(fixture.workspace, ["rev-parse", "HEAD"]), fixture.baselineCommit);
});

test("повтор после сбоя push согласует scaffold без второго commit", async (context) => {
  const fixture = await repository(context);
  const service = createChangeInitializationService({ command: commandFor(fixture) });
  const session = await service.prepare(fixture.workspace, changeId, changeBranch);
  fixture.pushFailures = 1;
  await assert.rejects(
    service.initialize(fixture.workspace, session),
    /Не удалось опубликовать ветку/,
  );
  const committedHead = await git(fixture.workspace, ["rev-parse", "HEAD"]);
  const initialized = await service.initialize(fixture.workspace, session);
  assert.equal(initialized.pullRequest.number, 41);
  assert.equal(await git(fixture.workspace, ["rev-parse", "HEAD"]), committedHead);
  assert.equal(
    await git(fixture.workspace, ["rev-list", "--count", `${fixture.baselineCommit}..HEAD`]),
    "1",
  );
  assert.equal(fixture.newCalls, 1);
});

test("повтор после сбоя ответа GitHub переиспользует созданный Draft PR", async (context) => {
  const fixture = await repository(context);
  const service = createChangeInitializationService({ command: commandFor(fixture) });
  const session = await service.prepare(fixture.workspace, changeId, changeBranch);
  fixture.createPullRequestFailuresAfterEffect = 1;

  await assert.rejects(
    service.initialize(fixture.workspace, session),
    /Не удалось создать Draft pull request/,
  );
  assert.equal(fixture.pullRequests.length, 1);
  assert.equal(fixture.pullRequests[0].isDraft, true);

  fixture.pullRequests[0].isDraft = false;
  await assert.rejects(
    service.initialize(fixture.workspace, session),
    /не соответствует опубликованной change-ветке/,
  );
  fixture.pullRequests[0].isDraft = true;
  const initialized = await service.initialize(fixture.workspace, session);
  assert.equal(initialized.pullRequest.number, 41);
  assert.equal(fixture.pullRequests.length, 1);
  assert.equal(fixture.newCalls, 1);
});

test("root PR fail-closed проверяет дубли и fork", async (context) => {
  await context.test("duplicate open PR", async (child) => {
    const fixture = await repository(child, { existing: true });
    fixture.pullRequests = [9, 10].map((number) => ({
      number,
      url: `${repositoryUrl}/pull/${number}`,
      state: "OPEN",
      isDraft: true,
      isCrossRepository: false,
      baseRefName: "develop",
      headRefName: changeBranch,
      headRefOid: fixture.baselineCommit,
      title: "Root PR",
      body: "Root PR body",
    }));
    const service = createChangeInitializationService({ command: commandFor(fixture) });
    await assert.rejects(
      service.prepare(fixture.workspace, changeId, changeBranch),
      /несколько открытых pull request/,
    );
  });

  await context.test("fork PR", async (child) => {
    const fixture = await repository(child, { existing: true });
    fixture.pullRequests = [{
      number: 9,
      url: `${repositoryUrl}/pull/9`,
      state: "OPEN",
      isDraft: true,
      isCrossRepository: true,
      baseRefName: "develop",
      headRefName: changeBranch,
      headRefOid: fixture.baselineCommit,
      title: "Root PR",
      body: "Root PR body",
    }];
    const service = createChangeInitializationService({ command: commandFor(fixture) });
    await assert.rejects(
      service.prepare(fixture.workspace, changeId, changeBranch),
      /не соответствует change-ветке/,
    );
    assert.equal(fixture.updateCalls, 0);
  });

});

test("закрытый root PR не переоткрывается и не мешает создать новый Draft PR", async (context) => {
  const fixture = await repository(context, { existing: true });
  fixture.pullRequests = [{
    number: 8,
    url: `${repositoryUrl}/pull/8`,
    state: "CLOSED",
    isDraft: false,
    isCrossRepository: false,
    baseRefName: "main",
    headRefName: changeBranch,
    headRefOid: fixture.baselineCommit,
    title: "Закрытый PR",
    body: "Закрытый PR",
  }];
  const service = createChangeInitializationService({ command: commandFor(fixture) });
  const session = await service.prepare(fixture.workspace, changeId, changeBranch);
  const initialized = await service.initialize(fixture.workspace, session);

  assert.equal(initialized.pullRequest.number, 41);
  assert.equal(fixture.pullRequests.length, 1);
  assert.equal(fixture.pullRequests[0].number, 41);
  assert.equal(fixture.pullRequests[0].isDraft, true);
});

test("fail-closed отклоняет некорректный JSON, чужие пути и изменения вне change", async (context) => {
  await context.test("invalid list JSON", async (child) => {
    const fixture = await repository(child);
    fixture.invalidListJson = true;
    const service = createChangeInitializationService({ command: commandFor(fixture) });
    await assert.rejects(
      service.prepare(fixture.workspace, changeId, changeBranch),
      /Не удалось получить список OpenSpec changes/,
    );
  });
  await context.test("OpenSpec root outside workspace", async (child) => {
    const fixture = await repository(child);
    fixture.rootOutputPath = fixture.root;
    const service = createChangeInitializationService({ command: commandFor(fixture) });
    await assert.rejects(
      service.prepare(fixture.workspace, changeId, changeBranch),
      /Не удалось получить список OpenSpec changes/,
    );
  });
  await context.test("invalid new JSON", async (child) => {
    const fixture = await repository(child);
    fixture.invalidNewJson = true;
    const service = createChangeInitializationService({ command: commandFor(fixture) });
    const session = await service.prepare(fixture.workspace, changeId, changeBranch);
    await assert.rejects(
      service.initialize(fixture.workspace, session),
      /Не удалось создать OpenSpec change/,
    );
  });
  await context.test("reported path outside change root", async (child) => {
    const fixture = await repository(child);
    fixture.createdPathOverride = fixture.root;
    const service = createChangeInitializationService({ command: commandFor(fixture) });
    const session = await service.prepare(fixture.workspace, changeId, changeBranch);
    await assert.rejects(
      service.initialize(fixture.workspace, session),
      /пути нового change за пределами/,
    );
  });
  await context.test("invalid status JSON", async (child) => {
    const fixture = await repository(child);
    const service = createChangeInitializationService({ command: commandFor(fixture) });
    const session = await service.prepare(fixture.workspace, changeId, changeBranch);
    fixture.invalidStatusJson = true;
    await assert.rejects(
      service.initialize(fixture.workspace, session),
      /Не удалось безопасно определить каталог change/,
    );
  });
  await context.test("foreign changed path", async (child) => {
    const fixture = await repository(child);
    fixture.addForeignPath = true;
    const service = createChangeInitializationService({ command: commandFor(fixture) });
    const session = await service.prepare(fixture.workspace, changeId, changeBranch);
    await assert.rejects(
      service.initialize(fixture.workspace, session),
      /за пределами созданного change/,
    );
  });
});

test("prepare отклоняет branch/change mismatch до внешних эффектов", async (context) => {
  const fixture = await repository(context);
  const service = createChangeInitializationService({ command: commandFor(fixture) });
  await assert.rejects(
    service.prepare(fixture.workspace, "other-change", changeBranch),
    ChangeInitializationError,
  );
  assert.equal(fixture.newCalls, 0);
});

test("длинный change ID использует короткий fallback subject", () => {
  assert.equal(
    changeCommitSubject("a".repeat(80)),
    "docs(openspec): add change scaffold",
  );
});
