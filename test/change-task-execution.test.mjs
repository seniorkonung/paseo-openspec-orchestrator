import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  changeTaskExecutionPrompt,
  createChangeTaskExecutionService,
} from "../server/change-task-execution.ts";

const execFileAsync = promisify(execFile);
const changeId = "selected-change";
const parentBranch = "selected-change-review";
const parentBaseBranch = "selected-change";
const taskBranch = "selected-change-task-1.1";
const repository = "example/project";
const repositoryUrl = "https://github.com/example/project";
const originUrl = "git@github.com:example/project.git";
const title = "Реализовать задачу 1.1 OpenSpec change";
const body = `## Результат

Реализовано поведение выбранной задачи и добавлена проверка.`;

const exec = async (executable, arguments_, options) => {
  const result = await execFileAsync(executable, arguments_, {
    cwd: options.cwd,
    signal: options.signal,
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

async function connectClient(url) {
  const client = new Client({ name: "change-task-execution-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

function highProfile() {
  return {
    id: "profile-high",
    name: "High",
    provider: "codex",
    model: "gpt-6-astra",
    modeId: "default",
    thinkingOptionId: "high",
    featureValues: { fast: true },
  };
}

function firstText(result) {
  const content = result.content[0];
  assert.equal(content?.type, "text");
  return content.text;
}

async function createFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "openspec-task-execution-"));
  const workspace = join(root, "workspace");
  const bare = join(root, "origin.git");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(workspace, "openspec", "changes", changeId), { recursive: true });
  await execFileAsync("git", ["init", "--bare", bare]);
  await execFileAsync("git", ["init", "-b", parentBranch], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "OpenSpec Test"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["config", "user.email", "openspec@example.test"], {
    cwd: workspace,
  });
  const tasksPath = join(workspace, "openspec", "changes", changeId, "tasks.md");
  await writeFile(
    tasksPath,
    "## 1. Реализация\n- [ ] 1.1 Реализовать выбранное поведение\n- [ ] 1.2 Добавить следующий этап\n",
  );
  await execFileAsync("git", ["add", "openspec"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "docs(openspec): add task plan"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["remote", "add", "origin", bare], { cwd: workspace });
  await execFileAsync("git", ["push", "-u", "origin", parentBranch], {
    cwd: workspace,
  });
  const baselineCommit = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })
  ).stdout.trim();

  let taskPullRequest = null;
  const applyInstructions = async () => {
    const tasks = await readFile(tasksPath, "utf8");
    const firstDone = tasks.includes("- [x] 1.1");
    const secondDone = tasks.includes("- [x] 1.2");
    const complete = Number(firstDone) + Number(secondDone);
    return {
      changeName: changeId,
      schemaName: "spec-driven",
      progress: { total: 2, complete, remaining: 2 - complete },
      tasks: [
        { id: "1", description: "1.1 Реализовать выбранное поведение", done: firstDone },
        { id: "2", description: "1.2 Добавить следующий этап", done: secondDone },
      ],
      state: complete === 2 ? "all_done" : "ready",
      instruction: complete === 2 ? "All tasks complete" : "Implement remaining tasks",
    };
  };
  const parentPullRequest = {
    number: 43,
    url: `${repositoryUrl}/pull/43`,
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    baseRefName: parentBaseBranch,
    headRefName: parentBranch,
    headRefOid: baselineCommit,
    title: "Первичное ревью change",
    body: "Review",
  };

  const command = async (executable, arguments_, options) => {
    const key = `${executable} ${arguments_.join(" ")}`;
    if (executable === "mise") {
      assert.deepEqual(arguments_, [
        "exec",
        "--no-deps",
        "--",
        "openspec",
        "instructions",
        "apply",
        "--change",
        changeId,
        "--json",
      ]);
      return { stdout: JSON.stringify(await applyInstructions()), stderr: "" };
    }
    if (key === "git remote get-url origin") {
      return { stdout: `${originUrl}\n`, stderr: "" };
    }
    if (key === "gh auth status --hostname github.com") {
      return { stdout: "", stderr: "" };
    }
    if (key === `gh repo view ${repository} --json nameWithOwner,url`) {
      return {
        stdout: JSON.stringify({ nameWithOwner: repository, url: repositoryUrl }),
        stderr: "",
      };
    }
    if (executable === "gh" && arguments_[0] === "pr" && arguments_[1] === "list") {
      const head = arguments_[arguments_.indexOf("--head") + 1];
      const state = arguments_[arguments_.indexOf("--state") + 1];
      if (head === parentBranch) {
        return { stdout: JSON.stringify([parentPullRequest]), stderr: "" };
      }
      if (head === taskBranch && taskPullRequest && (state === "open" || state === "all")) {
        return { stdout: JSON.stringify([taskPullRequest]), stderr: "" };
      }
      return { stdout: "[]", stderr: "" };
    }
    return exec(executable, arguments_, options);
  };

  return {
    workspace,
    tasksPath,
    baselineCommit,
    command,
    setTaskPullRequest(value) {
      taskPullRequest = value;
    },
  };
}

async function commitTask(fixture, { completeSecond = false } = {}) {
  await execFileAsync("git", ["switch", "-c", taskBranch, fixture.baselineCommit], {
    cwd: fixture.workspace,
  });
  await execFileAsync("git", ["push", "-u", "origin", taskBranch], {
    cwd: fixture.workspace,
  });
  const tasks = completeSecond
    ? "## 1. Реализация\n- [x] 1.1 Реализовать выбранное поведение\n- [x] 1.2 Добавить следующий этап\n"
    : "## 1. Реализация\n- [x] 1.1 Реализовать выбранное поведение\n- [ ] 1.2 Добавить следующий этап\n";
  await writeFile(fixture.tasksPath, tasks);
  await writeFile(join(fixture.workspace, "implementation.ts"), "export const implemented = true;\n");
  await execFileAsync("git", ["add", "openspec", "implementation.ts"], {
    cwd: fixture.workspace,
  });
  await execFileAsync("git", ["commit", "-m", "feat(task): implement selected task"], {
    cwd: fixture.workspace,
  });
  await execFileAsync("git", ["push", "origin", taskBranch], {
    cwd: fixture.workspace,
  });
  return (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.workspace })
  ).stdout.trim();
}

test("plan выбирает номер из description, а не позиционный OpenSpec ID", async (context) => {
  const fixture = await createFixture(context);
  const service = createChangeTaskExecutionService({
    command: fixture.command,
    async createAgent() {
      throw new Error("Агент не должен создаваться во время plan");
    },
  });

  const plan = await service.plan(fixture.workspace, changeId, parentBranch);

  assert.equal(plan.kind, "next-task");
  assert.equal(plan.session.taskId, "1");
  assert.equal(plan.session.taskNumber, "1.1");
  assert.equal(plan.session.taskBranch, taskBranch);
  assert.equal(plan.session.parentBranch, parentBranch);
  assert.equal(plan.session.parentBaseBranch, parentBaseBranch);
});

test("plan завершает all_done и fail-closed отклоняет ненумерованную задачу", async () => {
  const payload = {
    changeName: changeId,
    schemaName: "spec-driven",
    progress: { total: 1, complete: 1, remaining: 0 },
    tasks: [{ id: "1", description: "1.1 Готово", done: true }],
    state: "all_done",
    instruction: "Complete",
  };
  const service = createChangeTaskExecutionService({
    async command(executable) {
      assert.equal(executable, "mise");
      return { stdout: JSON.stringify(payload), stderr: "" };
    },
    async createAgent() {
      throw new Error("Агент не нужен");
    },
  });
  assert.deepEqual(await service.plan("/workspace", changeId, parentBranch), {
    kind: "complete",
    schemaName: "spec-driven",
  });

  payload.progress = { total: 1, complete: 0, remaining: 1 };
  payload.tasks = [{ id: "1", description: "Задача без номера", done: false }];
  payload.state = "ready";
  await assert.rejects(
    service.plan("/workspace", changeId, parentBranch),
    /не начинается с номера вида 1\.1/,
  );

  payload.progress = { total: 2, complete: 0, remaining: 2 };
  payload.tasks = [
    { id: "1", description: "1.1 Первая задача", done: false },
    { id: "2", description: "1.1 Вторая задача", done: false },
  ];
  await assert.rejects(
    service.plan("/workspace", changeId, parentBranch),
    /повторяющиеся номера/,
  );

  payload.state = "blocked";
  payload.instruction = "Заполните обязательный артефакт";
  await assert.rejects(
    service.plan("/workspace", changeId, parentBranch),
    /заблокирован: Заполните обязательный артефакт/,
  );
});

test("preflight fail-closed отклоняет уже занятую task-ветку", async (context) => {
  const fixture = await createFixture(context);
  await execFileAsync("git", ["branch", taskBranch, fixture.baselineCommit], {
    cwd: fixture.workspace,
  });
  const service = createChangeTaskExecutionService({
    command: fixture.command,
    async createAgent() {
      throw new Error("Агент не должен создаваться после ошибки preflight");
    },
  });

  await assert.rejects(
    service.plan(fixture.workspace, changeId, parentBranch),
    /Локальная task-ветка .* уже существует/,
  );
});

test("High-агент завершает одну задачу через scoped MCP и Ready stacked PR", async (context) => {
  const fixture = await createFixture(context);
  const labels = [];
  const links = [];
  const checkpoints = [];
  let prompt = "";
  let toolResult;
  const service = createChangeTaskExecutionService({
    command: fixture.command,
    async createAgent(options) {
      assert.equal(options.config.provider, "codex/gpt-6-astra");
      assert.equal(options.config.modeId, "default");
      assert.equal(options.config.thinkingOptionId, "high");
      assert.deepEqual(options.labels, { ntfy: "true" });
      const [{ url }] = Object.values(options.config.mcpServers);
      return {
        id: "agent-task-1.1",
        async commands() {
          return {
            commands: [
              { name: "openspec-apply-change", description: "apply" },
              { name: "change-summary", description: "summary" },
            ],
            error: null,
          };
        },
        async send(value) {
          prompt = value;
          const head = await commitTask(fixture);
          fixture.setTaskPullRequest({
            number: 44,
            url: `${repositoryUrl}/pull/44`,
            state: "OPEN",
            isDraft: false,
            isCrossRepository: false,
            baseRefName: parentBranch,
            headRefName: taskBranch,
            headRefOid: head,
            title,
            body,
          });
          const client = await connectClient(url);
          try {
            toolResult = await client.callTool({
              name: "complete_change_task",
              arguments: { pullRequestNumber: 44, title, body },
            });
          } finally {
            await client.close();
          }
        },
        async waitForFinish() {
          return { status: "idle" };
        },
      };
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, parentBranch);
  assert.equal(plan.kind, "next-task");

  const completed = await service.run({
    workspaceDirectory: fixture.workspace,
    profile: highProfile(),
    session: plan.session,
    signal: new AbortController().signal,
    onAgentCreated: (agentId) => links.push(agentId),
    onTaskCompleted: async (task) => checkpoints.push(task),
  });

  assert.equal(toolResult.isError, undefined);
  assert.equal(completed.taskNumber, "1.1");
  assert.equal(completed.branch, taskBranch);
  assert.equal(completed.remainingTasks, 1);
  assert.equal(completed.pullRequest.number, 44);
  assert.deepEqual(links, ["agent-task-1.1"]);
  assert.equal(checkpoints.length, 1);
  assert.deepEqual(labels, [["agent-task-1.1", false]]);
  assert.match(prompt, /\$openspec-apply-change selected-change Выполни задачу 1\.1/);
  assert.match(prompt, /\$change-summary/);
  assert.match(prompt, /complete_change_task/);
  assert.match(prompt, /end the turn silently/);
});

test("MCP возвращает feedback, если агент отметил следующую задачу", async (context) => {
  const fixture = await createFixture(context);
  const controller = new AbortController();
  const labels = [];
  let toolResult;
  let toolFinished;
  const toolFinishedPromise = new Promise((resolve) => {
    toolFinished = resolve;
  });
  const service = createChangeTaskExecutionService({
    command: fixture.command,
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      return {
        id: "agent-task-invalid-scope",
        async commands() {
          return {
            commands: [{ name: "openspec-apply-change" }, { name: "change-summary" }],
            error: null,
          };
        },
        async send() {
          const head = await commitTask(fixture, { completeSecond: true });
          fixture.setTaskPullRequest({
            number: 44,
            url: `${repositoryUrl}/pull/44`,
            state: "OPEN",
            isDraft: false,
            isCrossRepository: false,
            baseRefName: parentBranch,
            headRefName: taskBranch,
            headRefOid: head,
            title,
            body,
          });
          const client = await connectClient(url);
          try {
            toolResult = await client.callTool({
              name: "complete_change_task",
              arguments: { pullRequestNumber: 44, title, body },
            });
          } finally {
            await client.close();
            toolFinished();
          }
        },
        async waitForFinish() {
          return { status: "idle" };
        },
      };
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, parentBranch);
  assert.equal(plan.kind, "next-task");
  const execution = service.run({
    workspaceDirectory: fixture.workspace,
    profile: highProfile(),
    session: plan.session,
    signal: controller.signal,
    onAgentCreated() {},
    async onTaskCompleted() {
      throw new Error("Некорректная задача не должна сохраняться");
    },
  });

  await toolFinishedPromise;
  assert.equal(toolResult.isError, true);
  assert.match(firstText(toolResult), /единственным изменением task-state/);
  controller.abort();
  await assert.rejects(execution, { name: "AbortError" });
  assert.deepEqual(labels, [["agent-task-invalid-scope", false]]);
});

test("ошибка durable checkpoint восстанавливает ntfy и оставляет MCP для retry", async (context) => {
  const fixture = await createFixture(context);
  const controller = new AbortController();
  const labels = [];
  let toolResult;
  let toolFinished;
  const toolFinishedPromise = new Promise((resolve) => {
    toolFinished = resolve;
  });
  const service = createChangeTaskExecutionService({
    command: fixture.command,
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      return {
        id: "agent-task-checkpoint-error",
        async commands() {
          return {
            commands: [{ name: "openspec-apply-change" }, { name: "change-summary" }],
            error: null,
          };
        },
        async send() {
          const head = await commitTask(fixture);
          fixture.setTaskPullRequest({
            number: 44,
            url: `${repositoryUrl}/pull/44`,
            state: "OPEN",
            isDraft: false,
            isCrossRepository: false,
            baseRefName: parentBranch,
            headRefName: taskBranch,
            headRefOid: head,
            title,
            body,
          });
          const client = await connectClient(url);
          try {
            toolResult = await client.callTool({
              name: "complete_change_task",
              arguments: { pullRequestNumber: 44, title, body },
            });
          } finally {
            await client.close();
            toolFinished();
          }
        },
        async waitForFinish() {
          return { status: "idle" };
        },
      };
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, parentBranch);
  assert.equal(plan.kind, "next-task");
  const execution = service.run({
    workspaceDirectory: fixture.workspace,
    profile: highProfile(),
    session: plan.session,
    signal: controller.signal,
    onAgentCreated() {},
    async onTaskCompleted() {
      throw new Error("Ошибка fsync checkpoint");
    },
  });

  await toolFinishedPromise;
  assert.equal(toolResult.isError, true);
  assert.match(firstText(toolResult), /надёжно сохранить/);
  assert.deepEqual(labels, [
    ["agent-task-checkpoint-error", false],
    ["agent-task-checkpoint-error", true],
  ]);
  controller.abort();
  await assert.rejects(execution, { name: "AbortError" });
  assert.deepEqual(labels.at(-1), ["agent-task-checkpoint-error", false]);
});

test("prompt recovery не повторяет apply skill после готового коммита", async () => {
  const session = {
    changeId,
    schemaName: "spec-driven",
    taskId: "1",
    taskNumber: "1.1",
    taskDescription: "1.1 Реализовать выбранное поведение",
    parentBranch,
    parentBaseBranch,
    taskBranch,
    baselineCommit: "a".repeat(40),
    tasksBeforeDigest: "b".repeat(64),
    tasksAfterDigest: "c".repeat(64),
    progressTotal: 2,
    progressComplete: 0,
    repositoryHost: "github.com",
    repositoryNameWithOwner: repository,
    repositoryUrl,
    parentPullRequestNumber: 43,
  };
  const prompt = changeTaskExecutionPrompt({
    session,
    alreadyCommitted: true,
    existingPullRequest: 44,
  });
  assert.match(prompt, /already implemented/);
  assert.doesNotMatch(prompt, /\$openspec-apply-change/);
  assert.match(prompt, /\$change-summary/);
  assert.match(prompt, /pull request 44/);
});
