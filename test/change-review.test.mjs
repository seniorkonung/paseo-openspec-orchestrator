import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  changeReviewPrompt,
  createChangeReviewService,
  reviewCommitSubject,
} from "../server/change-review.ts";
import {
  reviewPullRequestBody,
  reviewPullRequestTitle,
} from "../server/change-review-publication.ts";

const execFileAsync = promisify(execFile);
const changeId = "complete-review-workflow";
const parentBranch = `change/${changeId}`;
const reviewBranch = `planning/${changeId}/initial`;
const repositoryUrl = "https://github.com/example/project";

function ultraProfile() {
  return {
    id: "profile-ultra",
    name: "Ultra",
    provider: "codex",
    model: "gpt-6-astra",
    modeId: "default",
    thinkingOptionId: "ultra",
    featureValues: { web: false },
  };
}

async function connectClient(url) {
  const client = new Client({ name: "change-review-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

function firstText(result) {
  const content = result.content[0];
  assert.equal(content?.type, "text");
  return content.text;
}

async function git(cwd, arguments_) {
  const result = await execFileAsync("git", arguments_, { cwd, encoding: "utf8" });
  return String(result.stdout).trim();
}

async function createRepository(context, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "openspec-review-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const remote = join(root, "origin.git");
  await mkdir(workspace);
  await git(workspace, ["init", "-b", parentBranch]);
  await git(workspace, ["config", "user.name", "OpenSpec Test"]);
  await git(workspace, ["config", "user.email", "openspec@example.test"]);
  const changeRoot = join(workspace, "openspec", "changes", changeId);
  await mkdir(changeRoot, { recursive: true });
  await writeFile(join(changeRoot, ".openspec.yaml"), "schema: spec-driven\n");
  await git(workspace, ["add", "openspec"]);
  await git(workspace, ["commit", "-m", "docs(openspec): add change scaffold"]);
  const parentBaselineCommit = await git(workspace, ["rev-parse", "HEAD"]);
  await git(root, ["init", "--bare", remote]);
  await git(workspace, ["remote", "add", "origin", remote]);
  await git(workspace, ["push", "--set-upstream", "origin", parentBranch]);
  await git(workspace, ["switch", "-c", reviewBranch, parentBaselineCommit]);
  await writeFile(join(changeRoot, "proposal.md"), "# Предложение\n");
  if (options.existingReview) {
    await writeFile(join(changeRoot, "review.md"), "# Предыдущее ревью\n");
  }
  await git(workspace, ["add", "openspec"]);
  await git(workspace, ["commit", "-m", "docs(openspec): add change"]);
  const baselineCommit = await git(workspace, ["rev-parse", "HEAD"]);
  await git(workspace, ["push", "--set-upstream", "origin", reviewBranch]);
  const fixture = {
    workspace,
    remote,
    changeRoot,
    reviewPath: join(changeRoot, "review.md"),
    parentBaselineCommit,
    baselineCommit,
  };
  fixture.github = {
    parentPullRequests: [parentPullRequest(fixture)],
    reviewPullRequests: [],
    historicalReviewPullRequests: [],
  };
  return fixture;
}

function parentPullRequest(fixture, overrides = {}) {
  return {
    number: 42,
    url: `${repositoryUrl}/pull/42`,
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    baseRefName: "main",
    headRefName: parentBranch,
    headRefOid: fixture.parentBaselineCommit,
    title: "Опубликовать OpenSpec change",
    body: "Исходный change PR",
    ...overrides,
  };
}

function reviewPullRequest(head, overrides = {}) {
  return {
    number: 43,
    url: `${repositoryUrl}/pull/43`,
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    baseRefName: parentBranch,
    headRefName: reviewBranch,
    headRefOid: head,
    title: reviewPullRequestTitle(changeId),
    body: reviewPullRequestBody(changeId),
    ...overrides,
  };
}

function createCommand(fixture) {
  const calls = [];
  const command = async (executable, arguments_, commandOptions = {}) => {
    calls.push({ executable, arguments: [...arguments_], options: commandOptions });
    if (executable === "mise") {
      assert.deepEqual(arguments_, [
        "exec", "--no-deps", "--", "openspec", "status", "--change", changeId, "--json",
      ]);
      return {
        stdout: JSON.stringify({
          changeName: changeId,
          changeRoot: fixture.changeRoot,
          actionContext: { mode: "repo-local", sourceOfTruth: "repo" },
        }),
        stderr: "",
      };
    }
    if (executable === "git" && arguments_[0] === "remote") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (executable === "gh") {
      if (arguments_[0] === "auth") return { stdout: "", stderr: "" };
      if (arguments_[0] === "repo") {
        return {
          stdout: JSON.stringify({ nameWithOwner: "example/project", url: repositoryUrl }),
          stderr: "",
        };
      }
      if (arguments_[0] === "pr" && arguments_[1] === "list") {
        const head = arguments_[arguments_.indexOf("--head") + 1];
        const state = arguments_[arguments_.indexOf("--state") + 1];
        const pullRequests = head === parentBranch
          ? fixture.github.parentPullRequests
          : state === "all"
            ? [...fixture.github.reviewPullRequests, ...fixture.github.historicalReviewPullRequests]
            : fixture.github.reviewPullRequests;
        return { stdout: JSON.stringify(pullRequests), stderr: "" };
      }
      if (arguments_[0] === "pr" && arguments_[1] === "view") {
        const number = Number(arguments_[2]);
        const pullRequest = [
          ...fixture.github.parentPullRequests,
          ...fixture.github.reviewPullRequests,
          ...fixture.github.historicalReviewPullRequests,
        ].find((candidate) => candidate.number === number);
        if (!pullRequest) throw new Error(`PR #${number} отсутствует`);
        return { stdout: JSON.stringify(pullRequest), stderr: "" };
      }
      throw new Error(`Неожиданный gh вызов: ${arguments_.join(" ")}`);
    }
    const result = await execFileAsync(executable, [...arguments_], {
      cwd: commandOptions.cwd,
      env: { ...process.env, ...commandOptions.env },
      signal: commandOptions.signal,
      encoding: "utf8",
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
  return { command, calls };
}

async function createReviewBranch(fixture) {
  assert.equal(await git(fixture.workspace, ["branch", "--show-current"]), reviewBranch);
}

async function commitReview(fixture, options = {}) {
  await writeFile(
    fixture.reviewPath,
    options.contents ?? "# Review\n\nПроблем не найдено.\n",
  );
  if (options.modifyProposal) {
    await writeFile(join(fixture.changeRoot, "proposal.md"), "# Изменено ошибочно\n");
  }
  if (options.extraPath) {
    await writeFile(join(fixture.workspace, options.extraPath), "лишний файл\n");
  }
  await git(fixture.workspace, ["add", "."]);
  await git(fixture.workspace, [
    "commit",
    "-m",
    options.subject ?? reviewCommitSubject(changeId),
  ]);
  return git(fixture.workspace, ["rev-parse", "HEAD"]);
}

function createServiceHarness(command, options = {}) {
  let resolveAgentCreated;
  const agentCreated = new Promise((resolve) => {
    resolveAgentCreated = resolve;
  });
  const labels = [];
  const service = createChangeReviewService({
    command,
    async createAgent(value) {
      resolveAgentCreated(value);
      return {
        id: options.agentId ?? "agent-review",
        async waitForFinish() {
          return { status: "idle" };
        },
      };
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });
  return { service, agentCreated, labels };
}

async function startRun(harness, fixture, session, signal = new AbortController().signal) {
  const running = harness.service.run({
    workspaceDirectory: fixture.workspace,
    profile: ultraProfile(),
    session,
    signal,
    onAgentCreated() {},
  });
  const agentOptions = await harness.agentCreated;
  const [{ url }] = Object.values(agentOptions.config.mcpServers);
  const client = await connectClient(url);
  assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), [
    "complete_change_review",
  ]);
  return { running, client, agentOptions };
}

test("plan сохраняет publication target и не пропускает существующий review.md", async (context) => {
  for (const existingReview of [false, true]) {
    await context.test(existingReview ? "review.md уже есть" : "review.md отсутствует", async (child) => {
      const fixture = await createRepository(child, { existingReview });
      const { command } = createCommand(fixture);
      const service = createChangeReviewService({ command, async createAgent() {} });
      assert.deepEqual(await service.plan(fixture.workspace, changeId, parentBranch, reviewBranch), {
        changeId,
        parentBranch,
        reviewBranch,
        parentBaselineCommit: fixture.parentBaselineCommit,
        baselineCommit: fixture.baselineCommit,
        repositoryHost: "github.com",
        repositoryNameWithOwner: "example/project",
        repositoryUrl,
        parentPullRequestNumber: 42,
      });
    });
  }
});

test("plan fail-closed проверяет parent publication и коллизии child-ветки", async (context) => {
  await context.test("dirty worktree", async (child) => {
    const fixture = await createRepository(child);
    const { command } = createCommand(fixture);
    await writeFile(join(fixture.workspace, "untracked.md"), "dirty\n");
    const service = createChangeReviewService({ command, async createAgent() {} });
    await assert.rejects(service.plan(fixture.workspace, changeId, parentBranch, reviewBranch), /незакоммиченные/);
  });
  await context.test("remote HEAD отстаёт", async (child) => {
    const fixture = await createRepository(child);
    const { command } = createCommand(fixture);
    await writeFile(join(fixture.changeRoot, "notes.md"), "# Notes\n");
    await git(fixture.workspace, ["add", "."]);
    await git(fixture.workspace, ["commit", "-m", "docs: add notes"]);
    const service = createChangeReviewService({ command, async createAgent() {} });
    await assert.rejects(service.plan(fixture.workspace, changeId, parentBranch, reviewBranch), /origin не содержит текущий HEAD/);
  });
  await context.test("parent PR отсутствует", async (child) => {
    const fixture = await createRepository(child);
    fixture.github.parentPullRequests = [];
    const { command } = createCommand(fixture);
    const service = createChangeReviewService({ command, async createAgent() {} });
    await assert.rejects(service.plan(fixture.workspace, changeId, parentBranch, reviewBranch), /ровно один открытый pull request/);
  });
  await context.test("parent PR дублируется", async (child) => {
    const fixture = await createRepository(child);
    fixture.github.parentPullRequests = [
      parentPullRequest(fixture),
      parentPullRequest(fixture, {
        number: 44,
        url: `${repositoryUrl}/pull/44`,
      }),
    ];
    const { command } = createCommand(fixture);
    const service = createChangeReviewService({ command, async createAgent() {} });
    await assert.rejects(service.plan(fixture.workspace, changeId, parentBranch, reviewBranch), /ровно один открытый pull request/);
  });
  await context.test("parent PR имеет неверную base", async (child) => {
    const fixture = await createRepository(child);
    fixture.github.parentPullRequests = [parentPullRequest(fixture, { baseRefName: "release" })];
    const { command } = createCommand(fixture);
    const service = createChangeReviewService({ command, async createAgent() {} });
    await assert.rejects(service.plan(fixture.workspace, changeId, parentBranch, reviewBranch), /в .*main/);
  });
  await context.test("исторический child PR уже существует", async (child) => {
    const fixture = await createRepository(child);
    fixture.github.historicalReviewPullRequests = [
      reviewPullRequest(fixture.baselineCommit, { state: "CLOSED" }),
    ];
    const { command } = createCommand(fixture);
    const service = createChangeReviewService({ command, async createAgent() {} });
    await assert.rejects(service.plan(fixture.workspace, changeId, parentBranch, reviewBranch), /уже существует pull request/);
  });
});

test("completion принимает один review-коммит и Ready PR child → parent", async (context) => {
  const fixture = await createRepository(context);
  const { command } = createCommand(fixture);
  const harness = createServiceHarness(command);
  const session = await harness.service.plan(fixture.workspace, changeId, parentBranch, reviewBranch);
  const { running, client, agentOptions } = await startRun(harness, fixture, session);
  assert.match(agentOptions.prompt, /openspec-review-change/);
  assert.match(agentOptions.prompt, /gh pr create --repo/);
  assert.match(agentOptions.prompt, /never use `gh pr edit`/);

  let result = await client.callTool({ name: "complete_change_review", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(firstText(result), /ещё не создал review\.md/);
  const reviewHead = await commitReview(fixture);
  result = await client.callTool({ name: "complete_change_review", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(firstText(result), /origin не содержит текущий HEAD planning-ветки/);
  await git(fixture.workspace, ["push", "origin", reviewBranch]);
  fixture.github.reviewPullRequests = [reviewPullRequest(reviewHead, { isDraft: true })];
  result = await client.callTool({ name: "complete_change_review", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(firstText(result), /Ready-публикации/);
  fixture.github.reviewPullRequests = [reviewPullRequest(reviewHead)];
  result = await client.callTool({ name: "complete_change_review", arguments: {} });
  assert.equal(result.isError, undefined);
  await client.close();
  assert.deepEqual(await running, {
    changeId,
    reviewPath: `openspec/changes/${changeId}/review.md`,
    branch: reviewBranch,
    pullRequest: {
      number: 43,
      url: `${repositoryUrl}/pull/43`,
      title: reviewPullRequestTitle(changeId),
    },
  });
  assert.deepEqual(harness.labels, [["agent-review", false]]);
});

test("существующий review.md изменяется, а planning-файлы остаются immutable", async (context) => {
  await context.test("обновлённый review.md принимается", async (child) => {
    const fixture = await createRepository(child, { existingReview: true });
    const { command } = createCommand(fixture);
    const harness = createServiceHarness(command);
    const session = await harness.service.plan(fixture.workspace, changeId, parentBranch, reviewBranch);
    await createReviewBranch(fixture);
    const head = await commitReview(fixture, { contents: "# Новое ревью\n\n- Finding F1\n" });
    await git(fixture.workspace, ["push", "origin", reviewBranch]);
    fixture.github.reviewPullRequests = [reviewPullRequest(head)];
    const { running, client } = await startRun(harness, fixture, session);
    const result = await client.callTool({ name: "complete_change_review", arguments: {} });
    assert.equal(result.isError, undefined);
    await client.close();
    await running;
  });
  await context.test("изменение proposal.md отклоняется", async (child) => {
    const fixture = await createRepository(child);
    const { command } = createCommand(fixture);
    const harness = createServiceHarness(command);
    const session = await harness.service.plan(fixture.workspace, changeId, parentBranch, reviewBranch);
    await createReviewBranch(fixture);
    await commitReview(fixture, { modifyProposal: true });
    const controller = new AbortController();
    const { running, client } = await startRun(harness, fixture, session, controller.signal);
    const result = await client.callTool({ name: "complete_change_review", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /planning-артефакты/);
    await client.close();
    controller.abort();
    await assert.rejects(running, /Операция отменена/);
  });
});

test("completion отклоняет неверный commit и PR metadata", async (context) => {
  for (const kind of [
    "multiple",
    "outside",
    "wrong-subject",
    "cross-repository",
    "wrong-base",
    "wrong-metadata",
  ]) {
    await context.test(kind, async (child) => {
      const fixture = await createRepository(child);
      const { command } = createCommand(fixture);
      const harness = createServiceHarness(command, { agentId: `agent-${kind}` });
      const session = await harness.service.plan(fixture.workspace, changeId, parentBranch, reviewBranch);
      await createReviewBranch(fixture);
      await commitReview(fixture, {
        subject: kind === "wrong-subject" ? "docs(openspec): add incorrect review" : reviewCommitSubject(changeId),
        extraPath: kind === "outside" ? "outside.md" : undefined,
      });
      if (kind === "multiple") {
        await writeFile(join(fixture.changeRoot, "review-details.md"), "# Details\n");
        await git(fixture.workspace, ["add", "."]);
        await git(fixture.workspace, ["commit", "-m", "docs: add review details"]);
      }
      const head = await git(fixture.workspace, ["rev-parse", "HEAD"]);
      await git(fixture.workspace, ["push", "origin", reviewBranch]);
      fixture.github.reviewPullRequests = [reviewPullRequest(head)];
      const controller = new AbortController();
      const { running, client } = await startRun(harness, fixture, session, controller.signal);
      if (kind === "cross-repository") {
        fixture.github.reviewPullRequests = [
          reviewPullRequest(head, { isCrossRepository: true }),
        ];
      }
      if (kind === "wrong-base") {
        fixture.github.reviewPullRequests = [
          reviewPullRequest(head, { baseRefName: "main" }),
        ];
      }
      if (kind === "wrong-metadata") {
        fixture.github.reviewPullRequests = [
          reviewPullRequest(head, { title: "Неверное название", body: "Неверное описание" }),
        ];
      }
      const result = await client.callTool({ name: "complete_change_review", arguments: {} });
      assert.equal(result.isError, true);
      if (kind === "multiple") assert.match(firstText(result), /ровно один/);
      if (kind === "outside") assert.match(firstText(result), /только новые файлы внутри/);
      if (kind === "wrong-subject") assert.equal(firstText(result).includes(reviewCommitSubject(changeId)), true);
      if (kind === "cross-repository") assert.match(firstText(result), /Ready-публикации/);
      if (kind === "wrong-base") assert.match(firstText(result), /Ready-публикации/);
      if (kind === "wrong-metadata") assert.match(firstText(result), /Ready-публикации/);
      await client.close();
      controller.abort();
      await assert.rejects(running, /Операция отменена/);
    });
  }
});

test("completion отклоняет изменившийся parent и rewrite review-коммита", async (context) => {
  for (const kind of ["parent-changed", "review-rewritten"]) {
    await context.test(kind, async (child) => {
      const fixture = await createRepository(child);
      const { command } = createCommand(fixture);
      const harness = createServiceHarness(command, { agentId: `agent-${kind}` });
      const session = await harness.service.plan(fixture.workspace, changeId, parentBranch, reviewBranch);
      await createReviewBranch(fixture);
      const head = await commitReview(fixture);
      await git(fixture.workspace, ["push", "origin", reviewBranch]);
      fixture.github.reviewPullRequests = [reviewPullRequest(head)];
      const controller = new AbortController();
      const { running, client } = await startRun(
        harness,
        fixture,
        session,
        controller.signal,
      );

      if (kind === "parent-changed") {
        await git(fixture.workspace, ["branch", "-f", parentBranch, head]);
      } else {
        await execFileAsync("git", ["commit", "--amend", "--no-edit"], {
          cwd: fixture.workspace,
          env: {
            ...process.env,
            GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z",
          },
        });
      }

      const result = await client.callTool({ name: "complete_change_review", arguments: {} });
      assert.equal(result.isError, true);
      if (kind === "parent-changed") assert.match(firstText(result), /Корневая ветка/);
      if (kind === "review-rewritten") assert.match(firstText(result), /origin не содержит текущий HEAD/);
      await client.close();
      controller.abort();
      await assert.rejects(running, /Операция отменена/);
    });
  }
});

test("рестарт принимает planning baseline и готовый review-коммит", async (context) => {
  for (const effect of ["planning-baseline", "review-commit"]) {
    await context.test(effect, async (child) => {
      const fixture = await createRepository(child);
      const { command } = createCommand(fixture);
      const planner = createChangeReviewService({ command, async createAgent() {} });
      const session = await planner.plan(fixture.workspace, changeId, parentBranch, reviewBranch);
      if (effect === "review-commit") await commitReview(fixture);

      const harness = createServiceHarness(command, { agentId: `agent-${effect}` });
      const controller = new AbortController();
      const { running, client, agentOptions } = await startRun(
        harness,
        fixture,
        session,
        controller.signal,
      );
      if (effect === "review-commit") {
        assert.match(agentOptions.prompt, /This is a recovery session/);
      } else {
        assert.match(agentOptions.prompt, /openspec-review-change/);
      }
      await client.close();
      controller.abort();
      await assert.rejects(running, /Операция отменена/);
    });
  }
});

test("рестарт согласует опубликованный commit и существующий PR без нового review", async (context) => {
  const fixture = await createRepository(context);
  const { command } = createCommand(fixture);
  const planner = createChangeReviewService({ command, async createAgent() {} });
  const session = await planner.plan(fixture.workspace, changeId, parentBranch, reviewBranch);
  await createReviewBranch(fixture);
  const reviewHead = await commitReview(fixture);
  await git(fixture.workspace, ["push", "origin", reviewBranch]);
  fixture.github.reviewPullRequests = [reviewPullRequest(reviewHead)];
  let toolFlow;
  let prompt;
  const service = createChangeReviewService({
    command,
    async createAgent(options) {
      prompt = options.prompt;
      const [{ url }] = Object.values(options.config.mcpServers);
      toolFlow = (async () => {
        const client = await connectClient(url);
        try {
          return await client.callTool({ name: "complete_change_review", arguments: {} });
        } finally {
          await client.close();
        }
      })();
      return {
        id: "agent-recovered-review",
        async waitForFinish() {
          await toolFlow;
          return { status: "idle" };
        },
      };
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
  await service.run({
    workspaceDirectory: fixture.workspace,
    profile: ultraProfile(),
    session,
    signal: new AbortController().signal,
    onAgentCreated() {},
  });
  assert.match(prompt, /This is a recovery session/);
  assert.match(prompt, /Do not invoke the review skill again/);
  assert.equal((await toolFlow).isError, undefined);
});

test("закрытый PR после рестарта не заменяется новым", async (context) => {
  const fixture = await createRepository(context);
  const { command } = createCommand(fixture);
  const service = createChangeReviewService({ command, async createAgent() {} });
  const session = await service.plan(fixture.workspace, changeId, parentBranch, reviewBranch);
  await createReviewBranch(fixture);
  fixture.github.historicalReviewPullRequests = [reviewPullRequest(fixture.baselineCommit, { state: "CLOSED" })];
  await assert.rejects(
    service.run({
      workspaceDirectory: fixture.workspace,
      profile: ultraProfile(),
      session,
      signal: new AbortController().signal,
      onAgentCreated() {},
    }),
    /больше не открыт/,
  );
});

test("prompt и PR title используют детерминированные fallback", () => {
  const longChangeId = `review-${"a".repeat(56)}`;
  assert.equal(reviewCommitSubject(longChangeId), "docs(openspec): add change review");
  const prompt = changeReviewPrompt({
    changeId: longChangeId,
    parentBranch,
    reviewBranch,
    parentBaselineCommit: "c".repeat(40),
    baselineCommit: "a".repeat(40),
    repository: "example/project",
    reviewRepositoryPath: `openspec/changes/${longChangeId}/review.md`,
    alreadyCommitted: false,
  });
  assert.match(prompt, /openspec-review-change/);
  assert.match(prompt, /docs\(openspec\): add change review/);
  assert.match(prompt, /Ready pull request/);
  assert.equal(reviewPullRequestTitle(`review-${"b".repeat(240)}`), "Первичное ревью OpenSpec change");
});
