import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

const execFileAsync = promisify(execFile);
const branch = "feature/review-change";
const changeId = "complete-review-workflow";

function ultraSandboxProfile() {
  return {
    id: "profile-ultra-sandbox",
    name: "Ultra Sandbox",
    provider: "codex",
    model: "gpt-6-astra",
    modeId: "sandbox",
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

async function createRepository(context) {
  const root = await mkdtemp(join(tmpdir(), "openspec-review-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const remote = join(root, "origin.git");
  await mkdir(workspace);
  await execFileAsync("git", ["init", "-b", branch], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "OpenSpec Test"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["config", "user.email", "openspec@example.test"], {
    cwd: workspace,
  });
  const changeRoot = join(workspace, "openspec", "changes", changeId);
  await mkdir(changeRoot, { recursive: true });
  await writeFile(join(changeRoot, "proposal.md"), "# Предложение\n");
  await execFileAsync("git", ["add", "openspec"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "docs(openspec): add change"], {
    cwd: workspace,
  });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
  });
  const baselineCommit = String(stdout).trim();
  await execFileAsync("git", ["init", "--bare", remote], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", remote], {
    cwd: workspace,
  });
  await execFileAsync("git", ["push", "--set-upstream", "origin", branch], {
    cwd: workspace,
  });
  return {
    workspace,
    changeRoot,
    reviewPath: join(changeRoot, "review.md"),
    baselineCommit,
  };
}

function createCommand(fixture) {
  const calls = [];
  const command = async (executable, arguments_, commandOptions = {}) => {
    calls.push({ executable, arguments: [...arguments_], options: commandOptions });
    if (executable === "mise") {
      assert.deepEqual(arguments_, [
        "exec",
        "--no-deps",
        "--",
        "openspec",
        "status",
        "--change",
        changeId,
        "--json",
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

async function commitReview(fixture, options = {}) {
  await writeFile(fixture.reviewPath, options.contents ?? "# Review\n\nПроблем не найдено.\n");
  if (options.extraPath) {
    await writeFile(join(fixture.workspace, options.extraPath), "лишний файл\n");
  }
  await execFileAsync("git", ["add", "."], { cwd: fixture.workspace });
  await execFileAsync(
    "git",
    ["commit", "-m", options.subject ?? reviewCommitSubject(changeId)],
    { cwd: fixture.workspace },
  );
}

test("plan создаёт стабильную review-сессию при отсутствии review.md", async (context) => {
  const fixture = await createRepository(context);
  const { command, calls } = createCommand(fixture);
  const service = createChangeReviewService({
    command,
    async createAgent() {
      throw new Error("Агент не должен создаваться во время plan");
    },
  });

  assert.deepEqual(await service.plan(fixture.workspace, changeId, branch), {
    kind: "review-required",
    session: {
      changeId,
      branch,
      baselineCommit: fixture.baselineCommit,
    },
  });
  assert.equal(
    calls.some(({ executable, arguments: arguments_ }) =>
      executable === "git" && arguments_.includes("ls-remote"),
    ),
    false,
  );
});

test("plan пропускает только непустой review из опубликованного HEAD", async (context) => {
  const fixture = await createRepository(context);
  const { command } = createCommand(fixture);
  const service = createChangeReviewService({ command, async createAgent() {} });

  await commitReview(fixture);
  await assert.rejects(
    service.plan(fixture.workspace, changeId, branch),
    /origin не содержит текущий HEAD/,
  );
  await execFileAsync("git", ["push", "origin", branch], { cwd: fixture.workspace });
  assert.deepEqual(await service.plan(fixture.workspace, changeId, branch), {
    kind: "already-reviewed",
    reviewPath: `openspec/changes/${changeId}/review.md`,
  });
});

test("plan отклоняет пустой файл, symlink и незакоммиченный review", async (context) => {
  await context.test("пустой файл", async (childContext) => {
    const fixture = await createRepository(childContext);
    const { command } = createCommand(fixture);
    const service = createChangeReviewService({ command, async createAgent() {} });
    await writeFile(fixture.reviewPath, "");
    await execFileAsync("git", ["add", "."], { cwd: fixture.workspace });
    await execFileAsync("git", ["commit", "-m", reviewCommitSubject(changeId)], {
      cwd: fixture.workspace,
    });
    await assert.rejects(
      service.plan(fixture.workspace, changeId, branch),
      /непустым обычным файлом/,
    );
  });

  await context.test("symlink", async (childContext) => {
    const fixture = await createRepository(childContext);
    const { command } = createCommand(fixture);
    const service = createChangeReviewService({ command, async createAgent() {} });
    await symlink("proposal.md", fixture.reviewPath);
    await execFileAsync("git", ["add", "."], { cwd: fixture.workspace });
    await execFileAsync("git", ["commit", "-m", reviewCommitSubject(changeId)], {
      cwd: fixture.workspace,
    });
    await assert.rejects(
      service.plan(fixture.workspace, changeId, branch),
      /непустым обычным файлом/,
    );
  });

  await context.test("директория", async (childContext) => {
    const fixture = await createRepository(childContext);
    const { command } = createCommand(fixture);
    const service = createChangeReviewService({ command, async createAgent() {} });
    await mkdir(fixture.reviewPath);
    await writeFile(join(fixture.reviewPath, "finding.md"), "# Finding\n");
    await execFileAsync("git", ["add", "."], { cwd: fixture.workspace });
    await execFileAsync("git", ["commit", "-m", reviewCommitSubject(changeId)], {
      cwd: fixture.workspace,
    });
    await assert.rejects(
      service.plan(fixture.workspace, changeId, branch),
      /непустым обычным файлом/,
    );
  });

  await context.test("незакоммиченный файл", async (childContext) => {
    const fixture = await createRepository(childContext);
    const { command } = createCommand(fixture);
    const service = createChangeReviewService({ command, async createAgent() {} });
    await writeFile(fixture.reviewPath, "# Review\n");
    await assert.rejects(
      service.plan(fixture.workspace, changeId, branch),
      /незакоммиченные или неотслеживаемые/,
    );
  });
});

test("review ждёт MCP между ходами агента и завершает только commit с push", async (context) => {
  const fixture = await createRepository(context);
  const { command, calls } = createCommand(fixture);
  const created = [];
  const labels = [];
  const completed = [];
  let drainCalls = 0;
  let agentCreated;
  const agentCreatedPromise = new Promise((resolve) => {
    agentCreated = resolve;
  });
  const service = createChangeReviewService({
    command,
    async createAgent(options) {
      created.push(options);
      agentCreated(options);
      return {
        id: "agent-review",
        async waitForFinish() {
          drainCalls += 1;
          return { status: "idle" };
        },
      };
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, branch);
  assert.equal(plan.kind, "review-required");
  const runPromise = service.run({
    workspaceDirectory: fixture.workspace,
    changeId,
    branch,
    profile: ultraSandboxProfile(),
    session: plan.session,
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onReviewCompleted(review) {
      completed.push(review);
    },
  });
  const options = await agentCreatedPromise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drainCalls, 0, "окончание хода не должно быть сигналом завершения этапа");
  assert.equal(created.length, 1);
  assert.equal(options.config.provider, "codex/gpt-6-astra");
  assert.equal(options.config.modeId, "sandbox");
  assert.equal(options.config.thinkingOptionId, "ultra");
  assert.deepEqual(options.config.featureValues, { web: false });
  assert.deepEqual(options.labels, { ntfy: "true" });
  assert.equal("cwd" in options, false);
  assert.equal("autoArchive" in options, false);
  assert.match(options.prompt, /openspec-review-change/);
  assert.match(options.prompt, new RegExp(changeId, "u"));
  assert.equal(
    calls.some(({ executable, arguments: arguments_ }) =>
      executable === "paseo" || arguments_.includes("commands"),
    ),
    false,
  );

  const [{ url }] = Object.values(options.config.mcpServers);
  const client = await connectClient(url);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name), ["complete_change_review"]);

  let toolResult = await client.callTool({
    name: "complete_change_review",
    arguments: {},
  });
  assert.equal(toolResult.isError, true);
  assert.match(firstText(toolResult), /ещё не создал review\.md/);

  await writeFile(fixture.reviewPath, "# Review\n\n## Findings\n\n- Найдена проблема.\n");
  toolResult = await client.callTool({ name: "complete_change_review", arguments: {} });
  assert.equal(toolResult.isError, true);
  assert.match(firstText(toolResult), /незакоммиченные или неотслеживаемые/);

  await commitReview(fixture);
  toolResult = await client.callTool({ name: "complete_change_review", arguments: {} });
  assert.equal(toolResult.isError, true);
  assert.match(firstText(toolResult), /origin не содержит текущий HEAD/);

  await execFileAsync("git", ["push", "--set-upstream", "origin", branch], {
    cwd: fixture.workspace,
  });
  toolResult = await client.callTool({ name: "complete_change_review", arguments: {} });
  assert.equal(toolResult.isError, undefined);
  await client.close();

  assert.deepEqual(await runPromise, {
    changeId,
    reviewPath: `openspec/changes/${changeId}/review.md`,
  });
  assert.equal(drainCalls, 1);
  assert.deepEqual(labels, [["agent-review", false]]);
  assert.deepEqual(completed, [
    { changeId, reviewPath: `openspec/changes/${changeId}/review.md` },
  ]);
});

async function rejectedCommitResult(context, kind) {
  const fixture = await createRepository(context);
  const { command } = createCommand(fixture);
  const controller = new AbortController();
  let options;
  let agentCreated;
  const created = new Promise((resolve) => {
    agentCreated = resolve;
  });
  const service = createChangeReviewService({
    command,
    async createAgent(value) {
      options = value;
      agentCreated();
      return { id: `agent-${kind}`, async waitForFinish() {} };
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, branch);
  const running = service.run({
    workspaceDirectory: fixture.workspace,
    changeId,
    branch,
    profile: ultraSandboxProfile(),
    session: plan.session,
    signal: controller.signal,
    onAgentCreated() {},
    async onReviewCompleted() {},
  });
  await created;

  await commitReview(fixture, {
    subject:
      kind === "wrong-subject"
        ? "docs(openspec): add an incorrect review"
        : reviewCommitSubject(changeId),
    extraPath: kind === "outside" ? "outside.md" : undefined,
  });
  if (kind === "multiple") {
    await writeFile(join(fixture.changeRoot, "details.md"), "# Детали\n");
    await execFileAsync("git", ["add", "."], { cwd: fixture.workspace });
    await execFileAsync("git", ["commit", "-m", "docs(openspec): add details"], {
      cwd: fixture.workspace,
    });
  }

  const [{ url }] = Object.values(options.config.mcpServers);
  const client = await connectClient(url);
  const result = await client.callTool({ name: "complete_change_review", arguments: {} });
  await client.close();
  controller.abort();
  await assert.rejects(running, /Операция отменена/);
  return result;
}

test("completion tool отклоняет лишние файлы, несколько коммитов и неверный subject", async (context) => {
  const outside = await rejectedCommitResult(context, "outside");
  assert.equal(outside.isError, true);
  assert.match(firstText(outside), /только новые файлы внутри выбранного change/);

  const multiple = await rejectedCommitResult(context, "multiple");
  assert.equal(multiple.isError, true);
  assert.match(firstText(multiple), /ровно один отдельный Git-коммит/);

  const wrongSubject = await rejectedCommitResult(context, "wrong-subject");
  assert.equal(wrongSubject.isError, true);
  assert.equal(firstText(wrongSubject).includes(reviewCommitSubject(changeId)), true);
});

test("ошибка checkpoint восстанавливает ntfy и допускает повторный tool call", async (context) => {
  const fixture = await createRepository(context);
  const { command } = createCommand(fixture);
  const labels = [];
  let options;
  let agentCreated;
  const created = new Promise((resolve) => {
    agentCreated = resolve;
  });
  let attempts = 0;
  const service = createChangeReviewService({
    command,
    async createAgent(value) {
      options = value;
      agentCreated();
      return { id: "agent-checkpoint-retry", async waitForFinish() {} };
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, branch);
  await commitReview(fixture);
  await execFileAsync("git", ["push", "origin", branch], { cwd: fixture.workspace });
  const running = service.run({
    workspaceDirectory: fixture.workspace,
    changeId,
    branch,
    profile: ultraSandboxProfile(),
    session: plan.session,
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onReviewCompleted() {
      attempts += 1;
      if (attempts === 1) throw new Error("checkpoint недоступен");
    },
  });
  await created;
  const [{ url }] = Object.values(options.config.mcpServers);
  const client = await connectClient(url);
  const first = await client.callTool({ name: "complete_change_review", arguments: {} });
  assert.equal(first.isError, true);
  assert.match(firstText(first), /повторите вызов/);
  const repeated = await Promise.all([
    client.callTool({ name: "complete_change_review", arguments: {} }),
    client.callTool({ name: "complete_change_review", arguments: {} }),
  ]);
  assert.equal(repeated[0].isError, undefined);
  assert.equal(repeated[1].isError, undefined);
  await client.close();
  await running;
  assert.deepEqual(labels, [
    ["agent-checkpoint-retry", false],
    ["agent-checkpoint-retry", true],
    ["agent-checkpoint-retry", false],
  ]);
  assert.equal(attempts, 2);
});

test("отмена review снимает ntfy и завершает ожидание", async (context) => {
  const fixture = await createRepository(context);
  const { command } = createCommand(fixture);
  const labels = [];
  const controller = new AbortController();
  let agentCreated;
  const created = new Promise((resolve) => {
    agentCreated = resolve;
  });
  const service = createChangeReviewService({
    command,
    async createAgent() {
      agentCreated();
      return { id: "agent-cancelled-review", async waitForFinish() {} };
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, branch);
  const running = service.run({
    workspaceDirectory: fixture.workspace,
    changeId,
    branch,
    profile: ultraSandboxProfile(),
    session: plan.session,
    signal: controller.signal,
    onAgentCreated() {},
    async onReviewCompleted() {},
  });
  await created;
  controller.abort();
  await assert.rejects(running, /Операция отменена/);
  assert.deepEqual(labels, [["agent-cancelled-review", false]]);
});

test("восстановительный агент публикует готовый коммит без повторного review", async (context) => {
  const fixture = await createRepository(context);
  const { command } = createCommand(fixture);
  const serviceForPlan = createChangeReviewService({ command, async createAgent() {} });
  const plan = await serviceForPlan.plan(fixture.workspace, changeId, branch);
  await commitReview(fixture);
  let prompt;
  let toolFlow;
  const service = createChangeReviewService({
    command,
    async createAgent(options) {
      prompt = options.prompt;
      const [{ url }] = Object.values(options.config.mcpServers);
      toolFlow = (async () => {
        await execFileAsync("git", ["push", "--set-upstream", "origin", branch], {
          cwd: fixture.workspace,
        });
        const client = await connectClient(url);
        try {
          return await client.callTool({
            name: "complete_change_review",
            arguments: {},
          });
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
    changeId,
    branch,
    profile: ultraSandboxProfile(),
    session: plan.session,
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onReviewCompleted() {},
  });
  assert.match(prompt, /recovering an interrupted workflow/);
  assert.match(prompt, /Do not invoke the review skill again/);
  assert.equal((await toolFlow).isError, undefined);
});

test("prompt использует fallback subject для длинного change id", () => {
  const longChangeId = `review-${"a".repeat(56)}`;
  assert.equal(reviewCommitSubject(longChangeId), "docs(openspec): add change review");
  const prompt = changeReviewPrompt({
    changeId: longChangeId,
    branch,
    reviewRepositoryPath: `openspec/changes/${longChangeId}/review.md`,
    alreadyCommitted: false,
  });
  assert.match(prompt, /openspec-review-change/);
  assert.match(prompt, /docs\(openspec\): add change review/);
});
