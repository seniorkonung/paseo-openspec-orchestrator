import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  changeTaskExecutionPrompt,
  createChangeTaskExecutionService,
} from "../server/change-task-execution.ts";
import { inspectTaskExecutionRecovery, verifyCompletedTask } from "../server/change-task-publication.ts";
import { collectImplementationTask } from "../server/implementation-run-model.ts";
import { createImplementationReviewService, implementationReviewPrompt } from "../server/implementation-review.ts";

const execFileAsync = promisify(execFile);
const changeId = "selected-change";
const changeBranch = `change/${changeId}`;
const implementationBranch = changeBranch;

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

async function fixture(context, { existingReview = false } = {}) {
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
  await writeFile(join(workspace, "openspec", "changes", changeId, "proposal.md"), "# Предложение\n");
  if (existingReview) {
    await writeFile(join(workspace, "openspec", "changes", changeId, "implementation-review.md"), "# Предыдущий review\n");
  }
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "docs(openspec): add tasks"], { cwd: workspace });
  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: workspace });
  await execFileAsync("git", ["push", "-u", "origin", changeBranch], { cwd: workspace });

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
  const calls = [];
  const command = async (executable, arguments_, options) => {
    calls.push(`${executable} ${arguments_.join(" ")}`);
    if (executable === "mise") {
      if (arguments_.includes("status")) {
        return {
          stdout: JSON.stringify({
            changeName: changeId,
            changeRoot: join(workspace, "openspec", "changes", changeId),
            actionContext: { mode: "repo-local", sourceOfTruth: "repo" },
          }),
          stderr: "",
        };
      }
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
    if (executable === "gh" && arguments_[0] === "pr" && ["list", "view"].includes(arguments_[1])) {
      const output = (await execFileAsync("git", ["ls-remote", "--heads", "origin", `refs/heads/${changeBranch}`], { cwd: workspace })).stdout;
      const remoteHead = output.trim().split(/\s/u)[0];
      const pr = {
        number: 41, url: "https://github.com/example/project/pull/41", state: "OPEN",
        isDraft: true, isCrossRepository: false, baseRefName: "main",
        headRefName: changeBranch, headRefOid: remoteHead,
        title: "Change", body: "Описание",
      };
      return { stdout: JSON.stringify(arguments_[1] === "list" ? [pr] : pr), stderr: "" };
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
    phaseNumber: 1,
    runNumber: 1,
    publication: { kind: "unreviewed" },
    batch: { kind: "empty", baseCommit: baseline },
  };
  return { workspace, remote, tasksPath, baseline, command, run, calls };
}

async function commitTask(value, { markSecond = false } = {}) {
  await writeFile(
    value.tasksPath,
    `## 1. Реализация\n- [x] 1.1 Первая задача\n- [${markSecond ? "x" : " "}] 1.2 Вторая задача\n`,
  );
  await writeFile(join(value.workspace, "implementation.ts"), "export const implemented = true;\n");
  await execFileAsync("git", ["add", "."], { cwd: value.workspace });
  await execFileAsync("git", ["commit", "-m", "feat(task): implement first task"], { cwd: value.workspace });
}

async function commitTaskFollowup(value) {
  await writeFile(join(value.workspace, "followup.ts"), "export const followup = true;\n");
  await execFileAsync("git", ["add", "followup.ts"], { cwd: value.workspace });
  await execFileAsync("git", ["commit", "-m", "Additional work for the same task"], { cwd: value.workspace });
}

async function reviewFixture(context, options) {
  const value = await fixture(context, options);
  const taskService = createChangeTaskExecutionService({ command: value.command, async createAgent() {} });
  const taskPlan = await taskService.plan(value.workspace, value.run);
  await commitTask(value);
  const completedTask = await verifyCompletedTask(
    value.command, value.workspace, value.workspace, taskPlan.session, new AbortController().signal,
  );
  const run = collectImplementationTask(value.run, {
    taskId: completedTask.taskId, taskNumber: completedTask.taskNumber, commit: completedTask.commit,
  });
  const review = createImplementationReviewService({ command: value.command, async createAgent() {} });
  const session = await review.plan(value.workspace, run);
  value.calls.length = 0;
  return {
    ...value, run, session,
    reportPath: join(value.workspace, "openspec", "changes", changeId, "implementation-review.md"),
    git: async (...args) => (await execFileAsync("git", args, { cwd: value.workspace })).stdout.trim(),
  };
}

async function runReview(value, action) {
  const review = createImplementationReviewService({
    command: value.command,
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      return {
        id: "implementation-review-agent",
        async commands() { return { commands: [{ name: "openspec-review-implementation" }], error: null }; },
        async send(prompt) {
          const client = await connectClient(url);
          try { await action(client, prompt); } finally { await client.close(); }
        },
        async waitForFinish() { return { status: "idle" }; },
      };
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
  return review.run({
    workspaceDirectory: value.workspace, profile: highProfile(), run: value.run, session: value.session,
    signal: new AbortController().signal, onAgentCreated() {}, async onReviewCompleted() {},
  });
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

test("plan завершает пакет на границе фазы при незавершённых задачах будущей фазы", async (context) => {
  const value = await fixture(context);
  const command = async (executable, arguments_, options) => {
    if (executable === "mise") {
      return {
        stdout: JSON.stringify({
          changeName: changeId,
          schemaName: "spec-driven",
          progress: { total: 2, complete: 1, remaining: 1 },
          tasks: [
            { id: "internal-a", description: "1.1 Первая задача", done: true },
            { id: "internal-c", description: "2.1 Будущая задача", done: false },
          ],
          state: "ready",
          instruction: "Выполнить задачи",
        }),
        stderr: "",
      };
    }
    return value.command(executable, arguments_, options);
  };
  const service = createChangeTaskExecutionService({ command, async createAgent() {} });
  const result = await service.plan(value.workspace, value.run);
  assert.deepEqual(result, {
    kind: "complete",
    schemaName: "spec-driven",
    reason: "phase-complete",
  });
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
  assert.match(prompt, /Never invoke `gh`/u);
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

test("task checkpoint восстанавливается до push и после push без повторной публикации", async (context) => {
  const value = await fixture(context);
  const calls = [];
  const command = async (executable, args, options) => {
    calls.push(`${executable} ${args.join(" ")}`);
    return value.command(executable, args, options);
  };
  const service = createChangeTaskExecutionService({ command, async createAgent() {} });
  const plan = await service.plan(value.workspace, value.run);
  assert.equal(plan.kind, "next-task");
  await commitTask(value);
  await commitTaskFollowup(value);
  const signal = new AbortController().signal;
  assert.deepEqual(
    await inspectTaskExecutionRecovery(command, value.workspace, value.workspace, plan.session, signal),
    { alreadyCommitted: true },
  );
  const first = await verifyCompletedTask(command, value.workspace, value.workspace, plan.session, signal);
  assert.equal(first.taskId, "internal-a");
  assert.deepEqual(
    await inspectTaskExecutionRecovery(command, value.workspace, value.workspace, plan.session, signal),
    { alreadyCommitted: true },
  );
  const second = await verifyCompletedTask(command, value.workspace, value.workspace, plan.session, signal);
  assert.deepEqual(second, first);
  assert.equal(calls.filter((call) => call.startsWith("git push ")).length, 1);
});

test("implementation review получает все коммиты задачи и её завершающий SHA", async (context) => {
  const value = await fixture(context);
  const taskService = createChangeTaskExecutionService({ command: value.command, async createAgent() {} });
  const taskPlan = await taskService.plan(value.workspace, value.run);
  assert.equal(taskPlan.kind, "next-task");
  await commitTask(value);
  const first = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: value.workspace })).stdout.trim();
  await commitTaskFollowup(value);
  const completed = await verifyCompletedTask(
    value.command, value.workspace, value.workspace, taskPlan.session, new AbortController().signal,
  );
  const run = collectImplementationTask(value.run, {
    taskId: completed.taskId,
    taskNumber: completed.taskNumber,
    commit: completed.commit,
  });
  const review = createImplementationReviewService({ command: value.command, async createAgent() {} });
  const session = await review.plan(value.workspace, run);
  const prompt = implementationReviewPrompt({
    session,
    reviewRepositoryPath: `openspec/changes/${changeId}/implementation-review.md`,
    alreadyCommitted: false,
    targetCommits: [first, completed.commit],
  });
  assert.deepEqual(session.tasks.map(({ commit }) => commit), [completed.commit]);
  assert.ok(prompt.includes(`"targetCommits":["${first}","${completed.commit}"]`));
  assert.ok(prompt.includes(`"fromExclusive":"${value.baseline}"`));
  assert.ok(prompt.includes(`"throughInclusive":"${completed.commit}"`));
  await assert.rejects(
    review.plan(value.workspace, {
      ...run,
      batch: { ...run.batch, tasks: [{ ...run.batch.tasks[0], commit: first }] },
    }),
    /непроверенные коммиты/u,
  );
});

test("implementation review публикует правки кода и артефактов вместе с отчётом из двух коммитов", async (context) => {
  const value = await fixture(context);
  const taskService = createChangeTaskExecutionService({ command: value.command, async createAgent() {} });
  const taskPlan = await taskService.plan(value.workspace, value.run);
  await commitTask(value);
  const completedTask = await verifyCompletedTask(
    value.command, value.workspace, value.workspace, taskPlan.session, new AbortController().signal,
  );
  const run = collectImplementationTask(value.run, {
    taskId: completedTask.taskId,
    taskNumber: completedTask.taskNumber,
    commit: completedTask.commit,
  });
  const reportPath = join(value.workspace, "openspec", "changes", changeId, "implementation-review.md");
  let toolResult;
  const review = createImplementationReviewService({
    command: value.command,
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      return {
        id: "implementation-review-agent",
        async commands() { return { commands: [{ name: "openspec-review-implementation" }], error: null }; },
        async send() {
          await writeFile(reportPath, "# Review\n\nПервый проход.\n");
          await writeFile(join(value.workspace, "implementation.ts"), "export const implemented = 'исправлено';\n");
          await writeFile(join(value.workspace, "openspec", "changes", changeId, "proposal.md"), "# Уточнённое предложение\n");
          await execFileAsync("git", ["add", "."], { cwd: value.workspace });
          await execFileAsync("git", ["commit", "-m", "Первый проход review"], { cwd: value.workspace });
          await writeFile(reportPath, "# Review\n\nЗавершено.\n");
          await execFileAsync("git", ["add", "openspec"], { cwd: value.workspace });
          await execFileAsync("git", ["commit", "-m", "Дополнительный проход review"], { cwd: value.workspace });
          const client = await connectClient(url);
          try {
            toolResult = await client.callTool({ name: "complete_implementation_review", arguments: {} });
            assert.equal(toolResult.isError, undefined);
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
  const session = await review.plan(value.workspace, run);
  const result = await review.run({
    workspaceDirectory: value.workspace,
    profile: highProfile(),
    run,
    session,
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onReviewCompleted() {},
  });
  assert.equal(toolResult.isError, undefined);
  assert.equal(result.reviewedHead, completedTask.commit);
  assert.equal(result.reviewCommit, (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: value.workspace })).stdout.trim());
  assert.equal((await execFileAsync("git", ["rev-list", "--count", `${completedTask.commit}..HEAD`], { cwd: value.workspace })).stdout.trim(), "2");
});

test("implementation review продолжает незавершённую сессию после коммита кода без обновлённого отчёта", async (context) => {
  for (const existingReview of [false, true]) {
    await context.test(existingReview ? "старый отчёт не изменён" : "отчёт ещё не создан", async (subcontext) => {
      const value = await reviewFixture(subcontext, { existingReview });
      await writeFile(join(value.workspace, "implementation.ts"), "export const implemented = 'исправлено';\n");
      await value.git("add", ".");
      await value.git("commit", "-m", "fix(review): correct implementation");
      const result = await runReview(value, async (client, prompt) => {
        assert.match(prompt, /"alreadyCommitted":false/u);
        assert.match(prompt, /Invoke `openspec-review-implementation`/u);
        assert.ok(prompt.includes(`"targetCommits":["${value.session.reviewedHead}"]`));
        const incomplete = await client.callTool({ name: "complete_implementation_review", arguments: {} });
        assert.equal(incomplete.isError, true);
        assert.equal(value.calls.some((call) => call.startsWith("git push ")), false);
        await writeFile(value.reportPath, "# Review\n\nПравки проверены, нерешённых findings нет.\n");
        await value.git("add", ".");
        await value.git("commit", "-m", "docs(review): finish report");
        const completed = await client.callTool({ name: "complete_implementation_review", arguments: {} });
        assert.equal(completed.isError, undefined);
      });
      assert.equal(result.reviewedHead, value.session.reviewedHead);
      assert.equal(await value.git("rev-list", "--count", `${value.session.reviewedHead}..HEAD`), "2");
    });
  }
});

test("implementation review восстанавливает отчёт с правками до и после push без повторных коммитов", async (context) => {
  for (const published of [false, true]) {
    await context.test(published ? "после push" : "до push", async (subcontext) => {
      const value = await reviewFixture(subcontext);
      await writeFile(join(value.workspace, "implementation.ts"), "export const implemented = 'исправлено';\n");
      await writeFile(value.reportPath, "# Review\n\nПравки проверены.\n");
      await value.git("add", ".");
      await value.git("commit", "-m", "fix(review): correct implementation and report");
      const head = await value.git("rev-parse", "HEAD");
      if (published) await value.git("push", "origin", implementationBranch);
      const complete = async (client, prompt) => {
        assert.match(prompt, /"alreadyCommitted":true/u);
        assert.match(prompt, /Do not invoke the review skill/u);
        const result = await client.callTool({ name: "complete_implementation_review", arguments: {} });
        assert.equal(result.isError, undefined);
      };
      const first = await runReview(value, complete);
      const second = await runReview(value, complete);
      assert.deepEqual(second, first);
      assert.equal(first.reviewCommit, head);
      assert.equal(await value.git("rev-parse", "HEAD"), head);
      assert.equal(value.calls.filter((call) => call.startsWith("git push ")).length, published ? 0 : 1);
    });
  }
});

test("implementation review сохраняет завершение задач пакета при completion и recovery", async (context) => {
  for (const recovery of [false, true]) {
    await context.test(recovery ? "восстановление готового отчёта" : "завершение активного review", async (subcontext) => {
      const value = await reviewFixture(subcontext);
      const completedTasks = await readFile(value.tasksPath, "utf8");
      const reopen = async () => {
        await writeFile(value.tasksPath, completedTasks.replace("- [x] 1.1", "- [ ] 1.1"));
        await writeFile(value.reportPath, "# Review\n\nОтчёт с повторно открытой задачей.\n");
        await value.git("add", ".");
        await value.git("commit", "-m", "docs(review): update report and task state");
      };
      const restore = async () => {
        await writeFile(value.tasksPath, completedTasks);
        await value.git("add", ".");
        await value.git("commit", "-m", "fix(review): preserve completed task");
      };
      if (recovery) {
        await reopen();
        await assert.rejects(runReview(value, async () => {
          assert.fail("Review с повторно открытой задачей не должен считаться завершённым");
        }), /Выполненная задача 1\.1/u);
        assert.equal(value.calls.some((call) => call.startsWith("git push ")), false);
        await restore();
      }
      await runReview(value, async (client) => {
        if (!recovery) {
          await reopen();
          const rejected = await client.callTool({ name: "complete_implementation_review", arguments: {} });
          assert.equal(rejected.isError, true);
          assert.match(rejected.content[0].text, /Выполненная задача 1\.1/u);
          assert.equal(value.calls.some((call) => call.startsWith("git push ")), false);
          await restore();
        }
        const completed = await client.callTool({ name: "complete_implementation_review", arguments: {} });
        assert.equal(completed.isError, undefined);
      });
    });
  }
});

test("implementation review отклоняет задачи другого change и повторяющиеся ID до публикации", async (context) => {
  for (const response of ["другой change", "повторяющиеся ID"]) {
    await context.test(response, async (subcontext) => {
      const value = await reviewFixture(subcontext);
      const command = value.command;
      let invalid = true;
      value.command = async (executable, args, options) => {
        const result = await command(executable, args, options);
        if (invalid && executable === "mise" && args.includes("apply")) {
          const instructions = JSON.parse(result.stdout);
          if (response === "другой change") instructions.changeName = "other-change";
          else {
            instructions.tasks[1] = { ...instructions.tasks[0] };
            instructions.progress = { total: 2, complete: 2, remaining: 0 };
            instructions.state = "all_done";
          }
          return { stdout: JSON.stringify(instructions), stderr: "" };
        }
        return result;
      };
      await runReview(value, async (client) => {
        await writeFile(value.reportPath, "# Review\n\nПравки проверены.\n");
        await value.git("add", ".");
        await value.git("commit", "-m", "docs(review): complete report");
        const rejected = await client.callTool({ name: "complete_implementation_review", arguments: {} });
        assert.equal(rejected.isError, true);
        assert.match(rejected.content[0].text, response === "другой change" ? /другого change/u : /повторяющиеся ID/u);
        assert.equal(value.calls.some((call) => call.startsWith("git push ")), false);
        invalid = false;
        const completed = await client.callTool({ name: "complete_implementation_review", arguments: {} });
        assert.equal(completed.isError, undefined);
      });
    });
  }
});

test("implementation review не публикует правки без обновлённого и безопасного отчёта в Git", async (context) => {
  for (const report of ["отсутствует", "не изменён", "удалён", "символьная ссылка", "неверный UTF-8", "не добавлен в Git"]) {
    await context.test(report, async (subcontext) => {
      const value = await reviewFixture(subcontext, { existingReview: report !== "отсутствует" });
      await runReview(value, async (client) => {
        await writeFile(join(value.workspace, "implementation.ts"), "export const implemented = 'исправлено';\n");
        if (["удалён", "символьная ссылка", "не добавлен в Git"].includes(report)) await rm(value.reportPath);
        if (report === "символьная ссылка") await symlink(join(value.workspace, "implementation.ts"), value.reportPath);
        if (report === "неверный UTF-8") await writeFile(value.reportPath, Buffer.from([0xff]));
        if (report === "не добавлен в Git") {
          await writeFile(join(value.workspace, ".gitignore"), "implementation-review.md\n");
        }
        await value.git("add", ".");
        await value.git("commit", "-m", "fix(review): incomplete report");
        if (report === "не добавлен в Git") await writeFile(value.reportPath, "# Незакоммиченный отчёт\n");
        const incomplete = await client.callTool({ name: "complete_implementation_review", arguments: {} });
        assert.equal(incomplete.isError, true);
        assert.match(incomplete.content[0].text, /implementation-review\.md/u);
        assert.equal(value.calls.some((call) => call.startsWith("git push ")), false);
        await rm(value.reportPath, { force: true });
        await writeFile(value.reportPath, "# Review\n\nПравки проверены.\n");
        await value.git("add", "-f", value.reportPath);
        await value.git("commit", "-m", "docs(review): finish report");
        const completed = await client.callTool({ name: "complete_implementation_review", arguments: {} });
        assert.equal(completed.isError, undefined);
      });
    });
  }
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
  assert.match(prompt, /Never invoke `gh`/u);
  assert.match(prompt, new RegExp(implementationBranch, "u"));
});
