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
const changeBranch = `change/${changeId}`;
const implementationBranch = `implementation/${changeId}`;

async function exec(executable, arguments_, options) {
  const result = await execFileAsync(executable, arguments_, {
    cwd: options.cwd,
    signal: options.signal,
    encoding: "utf8",
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

async function connectClient(url) {
  const client = new Client({ name: "task-test", version: "1.0.0" });
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
  };
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "implementation-task-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const remote = join(root, "origin.git");
  await mkdir(join(workspace, "openspec", "changes", changeId), { recursive: true });
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["init", "-b", changeBranch], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "OpenSpec Test"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "openspec@example.test"], { cwd: workspace });
  const tasksPath = join(workspace, "openspec", "changes", changeId, "tasks.md");
  await writeFile(tasksPath, "## 1. Реализация\n- [ ] 1.1 Первая задача\n- [ ] 1.2 Вторая задача\n");
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "docs(openspec): add tasks"], { cwd: workspace });
  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: workspace });
  await execFileAsync("git", ["push", "-u", "origin", changeBranch], { cwd: workspace });
  await execFileAsync("git", ["switch", "-c", implementationBranch], { cwd: workspace });

  const apply = async () => {
    const tasks = await readFile(tasksPath, "utf8");
    const first = tasks.includes("- [x] 1.1");
    const second = tasks.includes("- [x] 1.2");
    const complete = Number(first) + Number(second);
    return {
      changeName: changeId,
      schemaName: "spec-driven",
      progress: { total: 2, complete, remaining: 2 - complete },
      tasks: [
        { id: "internal-a", description: "1.1 Первая задача", done: first },
        { id: "internal-b", description: "1.2 Вторая задача", done: second },
      ],
      state: complete === 2 ? "all_done" : "ready",
      instruction: "Выполнить задачи",
    };
  };
  const command = async (executable, arguments_, options) => {
    if (executable === "mise") {
      return { stdout: JSON.stringify(await apply()), stderr: "" };
    }
    if (executable === "git" && arguments_.join(" ") === "remote get-url origin") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (executable === "gh" && arguments_[0] === "auth") return { stdout: "", stderr: "" };
    if (executable === "gh" && arguments_[0] === "repo") {
      return {
        stdout: JSON.stringify({ nameWithOwner: "example/project", url: "https://github.com/example/project" }),
        stderr: "",
      };
    }
    return exec(executable, arguments_, options);
  };
  const run = {
    changeId,
    changeBranch,
    implementationBranch,
    rootBaselineCommit: baseline,
    repository: {
      host: "github.com",
      nameWithOwner: "example/project",
      url: "https://github.com/example/project",
    },
    publication: { kind: "unpublished" },
    batch: { kind: "empty", baseCommit: baseline },
    lastDeliveryHead: null,
    processedFeedbackFingerprints: [],
  };
  return { workspace, remote, tasksPath, baseline, command, run };
}

async function commitTask(value, { markSecond = false } = {}) {
  await writeFile(
    value.tasksPath,
    `## 1. Реализация\n- [x] 1.1 Первая задача\n- [${markSecond ? "x" : " "}] 1.2 Вторая задача\n`,
  );
  await writeFile(join(value.workspace, "implementation.ts"), "export const implemented = true;\n");
  await execFileAsync("git", ["add", "."], { cwd: value.workspace });
  await execFileAsync("git", ["commit", "-m", "feat(task): implement first task"], { cwd: value.workspace });
  await execFileAsync("git", ["push", "-u", "origin", implementationBranch], { cwd: value.workspace });
}

test("plan выбирает первую задачу и сохраняет общий implementation baseline", async (context) => {
  const value = await fixture(context);
  const service = createChangeTaskExecutionService({ command: value.command, async createAgent() {} });
  const plan = await service.plan(value.workspace, value.run);
  assert.equal(plan.kind, "next-task");
  assert.equal(plan.session.taskId, "internal-a");
  assert.equal(plan.session.taskNumber, "1.1");
  assert.equal(plan.session.implementationBranch, implementationBranch);
  assert.equal(plan.session.baselineCommit, value.baseline);
  assert.equal(plan.session.rootBaselineCommit, value.baseline);
  assert.equal("taskBranch" in plan.session, false);
  assert.equal("parentPullRequestNumber" in plan.session, false);
});

test("High-агент создаёт один task-коммит без task PR", async (context) => {
  const value = await fixture(context);
  let prompt = "";
  let toolResult;
  const completedCheckpoints = [];
  const service = createChangeTaskExecutionService({
    command: value.command,
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      return {
        id: "task-agent",
        async commands() {
          return { commands: [{ name: "openspec-apply-change" }], error: null };
        },
        async send(input) {
          prompt = input;
          await commitTask(value);
          const client = await connectClient(url);
          try {
            toolResult = await client.callTool({ name: "complete_change_task", arguments: {} });
          } finally {
            await client.close();
          }
        },
        async waitForFinish() { return { status: "idle" }; },
      };
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(value.workspace, value.run);
  const completed = await service.run({
    workspaceDirectory: value.workspace,
    profile: highProfile(),
    session: plan.session,
    signal: new AbortController().signal,
    onAgentCreated() {},
    onTaskCompleted: async (result) => completedCheckpoints.push(result),
  });
  assert.equal(toolResult.isError, undefined);
  assert.equal(completed.branch, implementationBranch);
  assert.equal(completed.taskId, "internal-a");
  assert.equal(completed.remainingTasks, 1);
  assert.match(completed.commit, /^[0-9a-f]{40}$/u);
  assert.equal(completedCheckpoints.length, 1);
  assert.match(prompt, /complete_change_task.*empty object/su);
  assert.match(prompt, /Do not invoke `gh`/u);
  assert.doesNotMatch(prompt, /change-summary/u);
  assert.doesNotMatch(prompt, /gh pr create/iu);
});

test("completion отклоняет изменение task-state следующей задачи", async (context) => {
  const value = await fixture(context);
  let toolResult;
  const service = createChangeTaskExecutionService({
    command: value.command,
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      return {
        id: "invalid-task-agent",
        async commands() { return { commands: [{ name: "openspec-apply-change" }], error: null }; },
        async send() {
          await commitTask(value, { markSecond: true });
          const client = await connectClient(url);
          try {
            toolResult = await client.callTool({ name: "complete_change_task", arguments: {} });
          } finally {
            await client.close();
          }
        },
        async waitForFinish() { return { status: "idle" }; },
      };
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(value.workspace, value.run);
  const controller = new AbortController();
  const pending = service.run({
    workspaceDirectory: value.workspace,
    profile: highProfile(),
    session: plan.session,
    signal: controller.signal,
    onAgentCreated() {},
    onTaskCompleted: async () => {},
  });
  while (!toolResult) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0].text, /единственным изменением task-state/u);
  controller.abort();
  await assert.rejects(pending, /abort/iu);
});

test("recovery prompt не повторяет apply и запрещает GitHub-операции", () => {
  const prompt = changeTaskExecutionPrompt({
    session: {
      changeId,
      schemaName: "spec-driven",
      taskId: "internal-a",
      taskNumber: "1.1",
      taskDescription: "1.1 Первая задача",
      changeBranch,
      implementationBranch,
      rootBaselineCommit: "a".repeat(40),
      baselineCommit: "b".repeat(40),
      tasksBeforeDigest: "c".repeat(64),
      tasksAfterDigest: "d".repeat(64),
      progressTotal: 2,
      progressComplete: 0,
      repositoryHost: "github.com",
      repositoryNameWithOwner: "example/project",
      repositoryUrl: "https://github.com/example/project",
    },
    alreadyCommitted: true,
  });
  assert.doesNotMatch(prompt, /\$openspec-apply-change/u);
  assert.match(prompt, /Do not invoke `gh`/u);
  assert.match(prompt, new RegExp(implementationBranch, "u"));
});
