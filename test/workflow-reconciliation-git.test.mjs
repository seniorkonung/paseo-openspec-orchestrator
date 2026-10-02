import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { REQUIRED_AGENT_PROFILE_NAMES } from "../server/agent-profiles.ts";
import { createChangeTaskExecutionService } from "../server/change-task-execution.ts";
import { OpenSpecOrchestratorEngine } from "../server/openspec-orchestrator-engine.ts";
import { OrchestratorLedger } from "../server/orchestrator-ledger.ts";
import { classifyPhaseWork, phaseTaskFingerprint } from "../server/phase-work.ts";
import { createRootBranchService } from "../server/root-branch-state.ts";
import { createWorkflowReconciler } from "../server/workflow/reconciliation.ts";
import { createExecuteChangeTasksStep } from "../server/workflow/steps/execute-change-tasks.ts";
import { createInitialWorkflowState } from "../server/workflow/types.ts";

const execFileAsync = promisify(execFile);
const changeId = "home-navigation";
const changeBranch = `change/${changeId}`;
const workspaceId = "workspace";
const repository = {
  host: "github.com",
  nameWithOwner: "example/project",
  url: "https://github.com/example/project",
};
const initialTasks = `## Phase 1
- [x] 1.1 Схема

## Phase 2
- [ ] 2.1 Чтение
- [ ] 2.2 Оболочка
- [ ] 2.3 Замена вставок
`;

/** Разбирает tasks.md так же, как OpenSpec: ID задачи — её позиция в файле. */
function parseTasks(markdown) {
  return [...markdown.matchAll(/^- \[([ x])\] (\d+\.\d+ .+)$/gmu)].map((match, index) => ({
    id: String(index + 1),
    description: match[2],
    done: match[1] === "x",
  }));
}

function profiles() {
  return REQUIRED_AGENT_PROFILE_NAMES.map((name) => ({
    id: `profile-${name.toLowerCase().replaceAll(" ", "-")}`,
    name,
    provider: "codex",
    model: "gpt-6-astra",
    modeId: "default",
    thinkingOptionId: "high",
  }));
}

/**
 * Настоящий Git-репозиторий с bare origin. OpenSpec и GitHub CLI заменены
 * ответами, которые вычисляются из файлов и refs этого репозитория.
 */
async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "workflow-reconciliation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const remote = join(root, "origin.git");
  const paseoHome = join(root, "paseo");
  const tasksPath = join(workspace, "openspec", "changes", changeId, "tasks.md");
  await mkdir(join(workspace, "openspec", "changes", changeId), { recursive: true });
  const git = async (...args) => (await execFileAsync("git", args, { cwd: workspace })).stdout.trim();
  await execFileAsync("git", ["init", "--bare", remote]);
  await git("init", "-b", changeBranch);
  await git("config", "user.name", "OpenSpec Test");
  await git("config", "user.email", "openspec@example.test");
  await writeFile(tasksPath, initialTasks);
  await git("add", ".");
  await git("commit", "-m", "docs(openspec): plan phase tasks");
  await git("remote", "add", "origin", remote);
  await git("push", "origin", changeBranch);
  const baseline = await git("rev-parse", "HEAD");
  const remoteHead = async () =>
    (await git("ls-remote", "--heads", "origin", `refs/heads/${changeBranch}`)).split(/\s/u)[0];

  const calls = [];
  const command = async (executable, args, options) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "mise") {
      const tasks = parseTasks(await readFile(tasksPath, "utf8"));
      const complete = tasks.filter(({ done }) => done).length;
      return {
        stdout: JSON.stringify({
          changeName: changeId,
          schemaName: "spec-driven",
          progress: { total: tasks.length, complete, remaining: tasks.length - complete },
          tasks,
          state: complete === tasks.length ? "all_done" : "ready",
          instruction: "Выполнить задачи",
        }),
        stderr: "",
      };
    }
    if (executable === "git" && args.join(" ") === "remote get-url origin") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (executable === "gh" && args[0] === "auth") return { stdout: "", stderr: "" };
    if (executable === "gh" && args[0] === "repo") {
      return { stdout: JSON.stringify({ nameWithOwner: repository.nameWithOwner, url: repository.url }), stderr: "" };
    }
    if (executable === "gh" && args[0] === "pr") {
      const pr = {
        number: 41, url: `${repository.url}/pull/41`, state: "OPEN", isDraft: true,
        isCrossRepository: false, baseRefName: "main", headRefName: changeBranch,
        headRefOid: await remoteHead(), title: "Change", body: "Описание",
      };
      return { stdout: JSON.stringify(args[1] === "list" ? [pr] : pr), stderr: "" };
    }
    const result = await execFileAsync(executable, args, { cwd: options.cwd, signal: options.signal, encoding: "utf8" });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };

  const phaseWork = {
    async inspect(_workspace, inspectedChange, previous) {
      assert.equal(inspectedChange, changeId);
      const tasks = parseTasks(await readFile(tasksPath, "utf8")).map(({ id, description, done }) => {
        const number = description.split(" ", 1)[0];
        return {
          id, number, description, done,
          phaseNumber: Number(number.split(".")[0]),
          fingerprint: phaseTaskFingerprint(id, number, description),
        };
      });
      return classifyPhaseWork({
        phases: [{ number: 1 }, { number: 2 }],
        tasks,
        schemaName: "spec-driven",
        planPath: join(workspace, "openspec", "changes", changeId, "plan.md"),
        taskArtifactPaths: [tasksPath],
      }, previous);
    },
  };

  // Агент этапа: каждое поручение исполняет очередной сценарий из очереди.
  const agentScripts = [];
  const agentRuns = [];
  const taskExecution = createChangeTaskExecutionService({
    command,
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      return {
        id: `task-agent-${agentRuns.length + 1}`,
        async commands() { return { commands: [{ name: "openspec-apply-change" }], error: null }; },
        async send(prompt) {
          const script = agentScripts.shift();
          assert.ok(script, "Агент запущен без сценария");
          const run = script({ prompt, url });
          agentRuns.push(run);
          await run;
        },
        async waitForFinish() { return { status: "idle" }; },
      };
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });

  /**
   * Агент выполняет порученную задачу и подтверждает её через MCP-инструмент.
   * `beforeCompletion` задерживает подтверждение, пока тест не подготовит
   * следующее действие пользователя.
   */
  const implementTask = (beforeCompletion = Promise.resolve()) => async ({ prompt, url }) => {
    const number = /"taskNumber":"([^"]+)"/u.exec(prompt)[1];
    const tasks = await readFile(tasksPath, "utf8");
    assert.ok(tasks.includes(`- [ ] ${number} `), `Задача ${number} должна быть незавершённой`);
    await writeFile(tasksPath, tasks.replace(`- [ ] ${number} `, `- [x] ${number} `));
    await writeFile(join(workspace, `task-${number}.ts`), `export const done = "${number}";\n`);
    await git("add", ".");
    await git("commit", "-m", `feat: implement task ${number}`);
    await beforeCompletion;
    const client = new Client({ name: "reconciliation-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      const result = await client.callTool({ name: "complete_change_task", arguments: {} });
      assert.equal(result.isError, undefined, result.content?.[0]?.text);
    } finally {
      await client.close();
    }
  };

  const reviewedRuns = [];
  const workflow = (seed) => ({
    startStepId: "seed",
    steps: [
      {
        id: "seed",
        label: "Готовлю implementation run",
        async run() {
          return { kind: "continue", next: "execute-change-tasks", state: await seed(), summary: "Run подготовлен" };
        },
      },
      createExecuteChangeTasksStep({
        workspaceDirectory: workspace,
        readAgentProfiles: async () => profiles(),
        taskExecution,
      }),
      {
        id: "review-implementation",
        label: "Проверяю пакет",
        async run({ state }) {
          reviewedRuns.push(state.implementationRun);
          return { kind: "complete", summary: "Пакет передан на review" };
        },
      },
    ],
    reconcile: createWorkflowReconciler({
      workspaceDirectory: workspace,
      rootBranch: createRootBranchService({ command }),
      phaseWork,
      sessions: {
        taskExecution: (session, signal) => taskExecution.assess(workspace, session, signal),
        // Остальные этапы в сценариях не участвуют.
        ...Object.fromEntries([
          "changeInitialization", "artifact", "review", "findingResolution",
          "implementationFindingResolution", "implementationReview", "phaseTaskPlanning", "archive",
        ].map((name) => [name, async () => { throw new Error(`Оценка «${name}» не ожидалась`); }])),
      },
    }),
  });

  const seedState = async () => ({
    ...createInitialWorkflowState(),
    changeBranch,
    activeBranch: changeBranch,
    change: { id: changeId },
    phaseProgress: {
      ...(await phaseWork.inspect(workspace, changeId, null)).progress,
      nextImplementationRun: 2,
    },
    implementationRun: {
      changeId,
      changeBranch,
      implementationBranch: changeBranch,
      phaseNumber: 2,
      runNumber: 1,
      rootBaselineCommit: baseline,
      repository,
      publication: { kind: "unreviewed" },
      batch: { kind: "empty", baseCommit: baseline },
    },
  });

  /** Запускает плагин: новый движок читает ledger с диска, как после перезагрузки. */
  const startPlugin = async () => {
    const ledger = new OrchestratorLedger({ paseoHome });
    await ledger.open(workspaceId);
    const engine = new OpenSpecOrchestratorEngine(ledger);
    engine.initialize(workspaceId, {
      workspaceDisplay: { projectName: null, workspaceName: null },
      refreshWorkspaceDisplay: async () => ({ projectName: null, workspaceName: null }),
      workflow: workflow(seedState),
    });
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      await engine.dispose();
      await ledger.close();
    };
    context.after(stop);
    return { ledger, engine, stop };
  };

  const settle = async (ledger) => {
    for (let attempt = 0; attempt < 3_000; attempt += 1) {
      const { status } = ledger.get(workspaceId).lifecycle;
      if (status !== "starting" && status !== "running" && status !== "pausing") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Workflow не завершился за отведённое время");
  };

  /**
   * Запускает workflow и ставит его на паузу после первой задачи: пауза
   * запрошена до того, как агент подтвердит задачу.
   */
  const pauseAfterFirstTask = async (plugin) => {
    let requestPause;
    const pauseRequested = new Promise((resolve) => { requestPause = resolve; });
    agentScripts.push(implementTask(pauseRequested));
    plugin.engine.command(workspaceId, "start");
    while (agentRuns.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    plugin.engine.command(workspaceId, "pause");
    requestPause();
    await settle(plugin.ledger);
    assert.equal(plugin.ledger.get(workspaceId).lifecycle.status, "paused");
  };

  return {
    workspace, tasksPath, baseline, git, remoteHead, calls, agentScripts, agentRuns,
    implementTask, pauseAfterFirstTask, reviewedRuns, startPlugin, settle,
  };
}

test("перестановка задач по просьбе пользователя подхватывается после перезапуска этапа", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const value = await fixture(context);

  // Агент задачи 2.1 выясняет, что сначала нужна «Замена вставок». Пользователь
  // просит переставить и перенумеровать задачи; агент коммитит правки и ждёт.
  let reordered;
  const agentIdle = new Promise((resolve) => { reordered = resolve; });
  value.agentScripts.push(async ({ prompt }) => {
    assert.match(prompt, /"taskNumber":"2\.1"/u);
    assert.match(prompt, /2\.1 Чтение/u);
    await writeFile(value.tasksPath, initialTasks.replace(
      "- [ ] 2.1 Чтение\n- [ ] 2.2 Оболочка\n- [ ] 2.3 Замена вставок\n",
      "- [ ] 2.3 Замена вставок\n- [ ] 2.1 Чтение\n- [ ] 2.2 Оболочка\n",
    ));
    await value.git("commit", "-am", "docs(openspec): order phase 2 tasks by execution sequence");
    await writeFile(value.tasksPath, initialTasks.replace(
      "- [ ] 2.1 Чтение\n- [ ] 2.2 Оболочка\n- [ ] 2.3 Замена вставок\n",
      "- [ ] 2.1 Замена вставок\n- [ ] 2.2 Чтение\n- [ ] 2.3 Оболочка\n",
    ));
    await value.git("commit", "-am", "docs(openspec): renumber phase 2 tasks by execution order");
    reordered();
  });
  const first = await value.startPlugin();
  first.engine.command(workspaceId, "start");
  await agentIdle;
  const reorderedHead = await value.git("rev-parse", "HEAD");
  assert.equal(await value.remoteHead(), value.baseline);
  assert.equal(
    first.ledger.getWorkflowCheckpoint(workspaceId).state.pendingTaskExecutionSession.taskDescription,
    "2.1 Чтение",
  );

  // Пользователь перезагружает плагин и снова запускает workflow.
  await first.stop();
  value.agentScripts.push(value.implementTask(), value.implementTask(), value.implementTask());
  const second = await value.startPlugin();
  assert.equal(second.ledger.get(workspaceId).lifecycle.availableCommand, "start");
  second.engine.command(workspaceId, "start");
  await value.settle(second.ledger);
  await Promise.all(value.agentRuns);

  const snapshot = second.ledger.get(workspaceId);
  assert.equal(snapshot.lifecycle.status, "completed", snapshot.lifecycle.message);
  const adoption = snapshot.history.find(({ text }) => text.startsWith("Принято состояние репозитория"));
  assert.equal(
    adoption.text,
    "Принято состояние репозитория: " +
      "принят изменённый список задач (Список задач перестал сохранять точный префикс на позиции 2); " +
      "сессия задачи 2.1 сброшена (OpenSpec больше не возвращает сохранённую задачу 2.1); " +
      "опубликовано коммитов: 2",
  );
  assert.equal(adoption.outcome, "succeeded");

  // Задачи выполнены в новом порядке, и все они попали в один пакет review.
  assert.deepEqual(
    parseTasks(await readFile(value.tasksPath, "utf8")).map(({ description, done }) => [description, done]),
    [
      ["1.1 Схема", true],
      ["2.1 Замена вставок", true],
      ["2.2 Чтение", true],
      ["2.3 Оболочка", true],
    ],
  );
  const head = await value.git("rev-parse", "HEAD");
  const [run] = value.reviewedRuns;
  assert.equal(value.reviewedRuns.length, 1);
  assert.equal(run.batch.kind, "collecting");
  assert.equal(run.batch.baseCommit, value.baseline);
  assert.equal(run.batch.headCommit, head);
  assert.deepEqual(run.batch.tasks.map(({ taskId, taskNumber }) => [taskId, taskNumber]), [
    ["2", "2.1"], ["3", "2.2"], ["4", "2.3"],
  ]);
  // Коммиты перестановки лежат внутри диапазона review и опубликованы.
  const range = (await value.git("rev-list", `${run.batch.baseCommit}..${run.batch.headCommit}`)).split("\n");
  assert.ok(range.includes(reorderedHead));
  assert.equal(range.length, 5);
  assert.equal(await value.remoteHead(), head);
  assert.equal(value.calls.some((call) => call.includes("--force")), false);
});

test("коммит пользователя между задачами не останавливает выполнение", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const value = await fixture(context);
  // После первой задачи пользователь добавляет свой коммит, пока workflow на паузе.
  const plugin = await value.startPlugin();
  await value.pauseAfterFirstTask(plugin);

  await writeFile(join(value.workspace, "manual-fix.ts"), "export const fixed = true;\n");
  await value.git("add", ".");
  await value.git("commit", "-m", "fix: ручная правка пользователя");
  const manualCommit = await value.git("rev-parse", "HEAD");

  value.agentScripts.push(value.implementTask(), value.implementTask());
  plugin.engine.command(workspaceId, "resume");
  await value.settle(plugin.ledger);
  await Promise.all(value.agentRuns);

  const snapshot = plugin.ledger.get(workspaceId);
  assert.equal(snapshot.lifecycle.status, "completed", snapshot.lifecycle.message);
  assert.equal(
    snapshot.history.find(({ text }) => text.startsWith("Принято состояние репозитория")).text,
    "Принято состояние репозитория: пакет implementation продолжен до текущего HEAD; опубликовано коммитов: 1",
  );
  const [run] = value.reviewedRuns;
  const range = (await value.git("rev-list", `${run.batch.baseCommit}..${run.batch.headCommit}`)).split("\n");
  assert.ok(range.includes(manualCommit));
  assert.deepEqual(run.batch.tasks.map(({ taskNumber }) => taskNumber), ["2.1", "2.2", "2.3"]);
  assert.equal(await value.remoteHead(), await value.git("rev-parse", "HEAD"));
});

test("переписанная история требует публикации пользователем и затем принимается", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const value = await fixture(context);
  const plugin = await value.startPlugin();
  await value.pauseAfterFirstTask(plugin);
  const published = await value.remoteHead();

  // Пользователь правит уже опубликованный коммит задачи.
  await writeFile(join(value.workspace, "task-2.1.ts"), "export const done = \"2.1, исправлено\";\n");
  await value.git("commit", "-a", "--amend", "-m", "feat: implement task 2.1 (исправлено)");
  plugin.engine.command(workspaceId, "resume");
  await value.settle(plugin.ledger);

  const halted = plugin.ledger.get(workspaceId);
  assert.equal(halted.lifecycle.status, "failed");
  assert.match(halted.lifecycle.message, /История локальной ветки «change\/home-navigation» переписана относительно origin/u);
  assert.match(halted.lifecycle.message, /git push --force-with-lease origin change\/home-navigation/u);
  assert.equal(await value.remoteHead(), published);
  assert.equal(value.calls.some((call) => call.startsWith("git push") && call.includes("--force")), false);

  // Пользователь сам публикует переписанную историю и нажимает «Повторить».
  await value.git("push", "--force-with-lease", "origin", changeBranch);
  value.agentScripts.push(value.implementTask(), value.implementTask());
  plugin.engine.command(workspaceId, "retry");
  await value.settle(plugin.ledger);
  await Promise.all(value.agentRuns);

  const snapshot = plugin.ledger.get(workspaceId);
  assert.equal(snapshot.lifecycle.status, "completed", snapshot.lifecycle.message);
  const adoption = snapshot.history.filter(({ text }) => text.startsWith("Принято состояние репозитория")).at(-1);
  assert.match(adoption.text, /завершающие коммиты задач 2\.1 исчезли из истории/u);
  assert.match(adoption.text, /пакет implementation продолжен до текущего HEAD/u);
  const [run] = value.reviewedRuns;
  assert.equal(run.batch.baseCommit, value.baseline);
  assert.deepEqual(run.batch.tasks.map(({ taskNumber, commit }) => [taskNumber, commit === null]), [
    ["2.1", true], ["2.2", false], ["2.3", false],
  ]);
  assert.equal(run.batch.headCommit, await value.git("rev-parse", "HEAD"));
});
