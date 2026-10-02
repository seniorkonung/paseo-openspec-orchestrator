import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  createPhaseTaskPlanningService,
  pendingPhaseTaskPlanningSessionSchema,
  phaseTaskPlanningPrompt,
  assertPhasePlanningDecision,
} from "../server/phase-task-planning.ts";
import { classifyPhaseWork, phaseTaskFingerprint } from "../server/phase-work.ts";
import { createValidatePhasePlanningStep } from "../server/workflow/steps/validate-phase-planning.ts";

const session = pendingPhaseTaskPlanningSessionSchema.parse({
  changeId: "phase-change",
  changeBranch: "change/phase-change",
  planningBranch: "change/phase-change",
  phaseNumber: 2,
  baselineCommit: "a".repeat(40),
  baselineProgress: {
    phases: [
      { number: 1, fingerprint: "1".repeat(64) },
      { number: 2, fingerprint: "2".repeat(64) },
    ],
    tasks: [{
      id: "task-a",
      number: "1.1",
      description: "1.1 Готовая задача",
      done: true,
      fingerprint: phaseTaskFingerprint("task-a", "1.1", "1.1 Готовая задача"),
    }],
    nextImplementationRun: 4,
  },
  taskPaths: ["openspec/changes/phase-change/tasks.md"],
});

const execFileAsync = promisify(execFile);

test("prompt прямо поручает openspec-update-change только одну фазу без catalog probe", () => {
  const prompt = phaseTaskPlanningPrompt(session, false);
  assert.match(prompt, /Invoke the openspec-update-change skill/u);
  assert.match(prompt, /exclusively for Phase 2/u);
  assert.match(prompt, /Do not inspect the command catalog first/u);
  assert.match(prompt, /interactive confirmation/u);
  assert.match(prompt, /at least one incomplete task numbered 2\.\*/u);
  assert.match(prompt, /strictly in file order\. List the new tasks in the order they must run/u);
  assert.doesNotMatch(prompt, /agent\.commands|commands\(\)/u);
});

test("recovery prompt запрещает повторный вызов skill и новый commit", () => {
  const prompt = phaseTaskPlanningPrompt(session, true);
  assert.match(prompt, /recovery session/u);
  assert.match(prompt, /Do not invoke the skill/u);
  assert.match(prompt, /do not invoke the skill, edit files, or amend\/create a commit/iu);
});

test("planning result сохраняет completion state старых задач и добавляет только целевую фазу", () => {
  const added = {
    id: "task-b",
    number: "2.1",
    description: "2.1 Новая задача",
    done: false,
    phaseNumber: 2,
    fingerprint: phaseTaskFingerprint("task-b", "2.1", "2.1 Новая задача"),
  };
  const preserved = {
    ...session.baselineProgress.tasks[0],
    phaseNumber: 1,
  };
  const decision = {
    kind: "implementation-required",
    phaseNumber: 2,
    runNumber: 4,
    progress: session.baselineProgress,
    snapshot: { tasks: [preserved, added] },
  };
  assert.doesNotThrow(() =>
    assertPhasePlanningDecision(decision, session.baselineProgress, 2)
  );
  assert.throws(
    () => assertPhasePlanningDecision(
      { ...decision, snapshot: { tasks: [{ ...preserved, done: false }, added] } },
      session.baselineProgress,
      2,
    ),
    /completion state/u,
  );
  assert.throws(
    () => assertPhasePlanningDecision(
      {
        ...decision,
        snapshot: {
          tasks: [preserved, added, {
            ...added,
            id: "task-c",
            phaseNumber: 1,
            number: "1.2",
            fingerprint: phaseTaskFingerprint("task-c", "1.2", "1.2 Новая задача"),
          }],
        },
      },
      session.baselineProgress,
      2,
    ),
    /При планировании Phase 2 новые задачи допускаются только в ней\. Задачи 1\.2 относятся к другим фазам/u,
  );
  assert.throws(
    () => assertPhasePlanningDecision(
      { ...decision, snapshot: { tasks: [preserved] } },
      session.baselineProgress,
      2,
    ),
    /незавершённую задачу 2\.\*/u,
  );
});

test("финальная проверка phase planning допускает правки review и сохраняет историю задач", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "phase-review-validation-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const changeRoot = join(workspace, "openspec", "changes", "phase-change");
  await mkdir(changeRoot, { recursive: true });
  const git = async (...args) => (await execFileAsync("git", args, { cwd: workspace })).stdout.trim();
  await git("init", "-b", session.planningBranch);
  await git("config", "user.name", "OpenSpec Test");
  await git("config", "user.email", "openspec@example.test");
  await writeFile(join(changeRoot, "tasks.md"), "- [x] 1.1 Готовая задача\n");
  await git("add", ".");
  await git("commit", "-m", "docs(openspec): add completed tasks");
  const baseline = await git("rev-parse", "HEAD");
  await writeFile(join(changeRoot, "tasks.md"), "- [x] 1.1 Готовая задача\n- [ ] 2.1 Новая задача\n");
  await git("add", ".");
  await git("commit", "-m", "docs(openspec): plan phase tasks");
  await writeFile(join(workspace, "application.ts"), "export const corrected = true;\n");
  await writeFile(join(changeRoot, "proposal.md"), "# Уточнённое предложение\n");
  await writeFile(join(changeRoot, "review.md"), "# Review\n\nПравки проверены.\n");
  await git("add", ".");
  await git("commit", "-m", "fix(review): correct code and artifacts");
  const preserved = { ...session.baselineProgress.tasks[0], phaseNumber: 1 };
  const added = {
    id: "task-b", number: "2.1", description: "2.1 Новая задача", done: false, phaseNumber: 2,
    fingerprint: phaseTaskFingerprint("task-b", "2.1", "2.1 Новая задача"),
  };
  const snapshot = {
    phases: [{ number: 1 }, { number: 2 }], tasks: [preserved, added],
    planPath: join(changeRoot, "plan.md"), taskArtifactPaths: [join(changeRoot, "tasks.md")],
  };
  const step = createValidatePhasePlanningStep({
    workspaceDirectory: workspace,
    command: async (executable, args, options) => {
      const result = await execFileAsync(executable, args, { cwd: options.cwd, signal: options.signal });
      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    },
    phaseWork: { async inspect(_workspace, _changeId, previous) { return classifyPhaseWork(snapshot, previous); } },
  });
  const workflowContext = {
    signal: new AbortController().signal,
    state: { planningRun: {
      planningBranch: session.planningBranch, rootBaselineCommit: baseline, changeId: session.changeId,
      baselineProgress: session.baselineProgress, phaseNumber: session.phaseNumber,
    } },
  };
  const result = await step.run(workflowContext);
  assert.equal(result.kind, "continue");
  assert.equal(result.next, "inspect-phase-work");
  assert.equal(result.state.planningRun, null);
  assert.equal(result.state.phaseProgress.tasks.length, 2);
  snapshot.tasks = [{ ...preserved, done: false }, added];
  const reopened = await step.run(workflowContext);
  assert.equal(reopened.kind, "halt");
  assert.match(reopened.summary, /снова открыта/u);
  snapshot.tasks = [added];
  const removed = await step.run(workflowContext);
  assert.equal(removed.kind, "halt");
  assert.match(removed.summary, /удалена ранее известная задача|точный префикс/u);
});

test("phase planning отклоняет правки кода и принимает несколько коммитов task-артефактов", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "phase-task-planning-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const taskPath = join(workspace, "openspec", "changes", "phase-change", "tasks.md");
  await mkdir(join(workspace, "openspec", "changes", "phase-change"), { recursive: true });
  const git = async (...args) => (await execFileAsync("git", args, { cwd: workspace })).stdout.trim();
  await git("init", "-b", "change/phase-change");
  await git("config", "user.name", "OpenSpec Test");
  await git("config", "user.email", "openspec@example.test");
  await writeFile(taskPath, "- [x] 1.1 Готовая задача\n");
  await git("add", ".");
  await git("commit", "-m", "Начальное состояние");
  const command = async (executable, args, options) => {
    const result = await execFileAsync(executable, args, { cwd: options.cwd, signal: options.signal });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
  const preserved = { ...session.baselineProgress.tasks[0], phaseNumber: 1 };
  const added = {
    id: "task-b", number: "2.1", description: "2.1 Новая задача", done: false,
    phaseNumber: 2, fingerprint: phaseTaskFingerprint("task-b", "2.1", "2.1 Новая задача"),
  };
  const phaseWork = {
    async inspect() {
      const count = Number(await git("rev-list", "--count", "HEAD"));
      return count === 1
        ? { kind: "planning-required", phaseNumber: 2, snapshot: { taskArtifactPaths: [taskPath] } }
        : { kind: "implementation-required", phaseNumber: 2, runNumber: 4,
          progress: session.baselineProgress, snapshot: { tasks: [preserved, added] } };
    },
  };
  let toolUrl;
  const service = createPhaseTaskPlanningService({
    command,
    phaseWork,
    async createAgent(options) {
      [{ url: toolUrl }] = Object.values(options.config.mcpServers);
      return { id: "phase-agent", async waitForFinish() { return { status: "idle" }; } };
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
  const plan = await service.prepare(
    workspace, "phase-change", "change/phase-change", "change/phase-change", 2, session.baselineProgress,
  );
  assert.equal(plan.kind, "planning-required");
  const prepared = plan.session;
  assert.deepEqual(
    await service.assess(workspace, prepared, new AbortController().signal),
    { kind: "resumable" },
  );
  const controller = new AbortController();
  let toolResult;
  let flow;
  const running = service.run({
    workspaceDirectory: workspace,
    profile: { id: "profile-high", name: "High", provider: "codex", model: "gpt-6-astra", modeId: "default", thinkingOptionId: "high" },
    session: prepared,
    signal: controller.signal,
    onAgentCreated() {
      flow = (async () => {
        await writeFile(taskPath, "- [x] 1.1 Готовая задача\n- [ ] 2.1 Новая задача\n");
        await git("add", ".");
        await git("commit", "-m", "Планирование фазы");
        await writeFile(taskPath, "- [x] 1.1 Готовая задача\n- [ ] 2.1 Новая задача\n\nДополнение.\n");
        await writeFile(join(workspace, "application.ts"), "export const unexpected = true;\n");
        await git("add", ".");
        await git("commit", "-m", "Уточнение плана");
        const client = new Client({ name: "phase-test", version: "1.0.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(toolUrl)));
        try {
          const rejected = await client.callTool({ name: "complete_phase_task_planning", arguments: {} });
          assert.equal(rejected.isError, true);
          assert.match(rejected.content[0].text, /только task-артефакты/u);
          await rm(join(workspace, "application.ts"));
          await git("add", ".");
          await git("commit", "-m", "fix(planning): preserve task scope");
          toolResult = await client.callTool({ name: "complete_phase_task_planning", arguments: {} });
        } finally {
          await client.close();
        }
      })();
      flow.catch(() => controller.abort());
    },
    async onCompleted() {},
  });
  const completed = await running;
  await flow;
  assert.equal(toolResult.isError, undefined);
  assert.equal(completed.commit, await git("rev-parse", "HEAD"));
  assert.equal(await git("rev-list", "--count", `${prepared.baselineCommit}..HEAD`), "3");
  const signal = new AbortController().signal;
  // Проверенный коммит с задачами продолжается той же сессией.
  assert.deepEqual(await service.assess(workspace, prepared, signal), { kind: "resumable" });

  // Задачи фазы уже есть в репозитории: агенту планировать нечего.
  const alreadyPlanned = await service.prepare(
    workspace, "phase-change", "change/phase-change", "change/phase-change", 2, session.baselineProgress,
  );
  assert.equal(alreadyPlanned.kind, "already-planned");
  assert.equal(alreadyPlanned.progress, session.baselineProgress);

  // Посторонний коммит после baseline эта сессия принять не может.
  await writeFile(join(workspace, "application.ts"), "export const foreign = true;\n");
  await git("add", ".");
  await git("commit", "-m", "feat: посторонняя правка");
  assert.deepEqual(await service.assess(workspace, prepared, signal), {
    kind: "stale",
    reason: "После baseline planning-сессии появились коммиты вне task-артефактов",
  });
  // Переписанная история лишает сессию baseline.
  await git("reset", "--hard", prepared.baselineCommit);
  await git("commit", "--amend", "-m", "Начальное состояние, переписано");
  await writeFile(taskPath, "- [x] 1.1 Готовая задача\n- [ ] 2.1 Новая задача\n");
  await git("add", ".");
  await git("commit", "-m", "Планирование фазы заново");
  assert.deepEqual(await service.assess(workspace, prepared, signal), {
    kind: "stale",
    reason: "Planning commit больше не продолжает baseline",
  });
});

test("незавершённое планирование в task-артефактах продолжает та же сессия", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "phase-task-planning-partial-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const taskPath = join(workspace, "openspec", "changes", "phase-change", "tasks.md");
  await mkdir(join(workspace, "openspec", "changes", "phase-change"), { recursive: true });
  const git = async (...args) => (await execFileAsync("git", args, { cwd: workspace })).stdout.trim();
  await git("init", "-b", "change/phase-change");
  await git("config", "user.name", "OpenSpec Test");
  await git("config", "user.email", "openspec@example.test");
  await writeFile(taskPath, "- [x] 1.1 Готовая задача\n");
  await git("add", ".");
  await git("commit", "-m", "Начальное состояние");
  const preserved = { ...session.baselineProgress.tasks[0], phaseNumber: 1 };
  const added = {
    id: "task-b", number: "2.1", description: "2.1 Новая задача", done: false,
    phaseNumber: 2, fingerprint: phaseTaskFingerprint("task-b", "2.1", "2.1 Новая задача"),
  };
  // Список задач читается из файла: задача фазы появляется только со своей строкой.
  const phaseWork = {
    async inspect() {
      const planned = (await git("show", "HEAD:openspec/changes/phase-change/tasks.md")).includes("2.1");
      return planned
        ? { kind: "implementation-required", phaseNumber: 2, runNumber: 4,
          progress: session.baselineProgress, snapshot: { tasks: [preserved, added] } }
        : { kind: "planning-required", phaseNumber: 2, progress: session.baselineProgress,
          snapshot: { tasks: [preserved], taskArtifactPaths: [taskPath] } };
    },
  };
  const service = createPhaseTaskPlanningService({
    command: async (executable, args, options) => {
      const result = await execFileAsync(executable, args, { cwd: options.cwd, signal: options.signal });
      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    },
    phaseWork,
    async createAgent() { throw new Error("Агент не нужен"); },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
  const plan = await service.prepare(
    workspace, "phase-change", "change/phase-change", "change/phase-change", 2, session.baselineProgress,
  );
  assert.equal(plan.kind, "planning-required");
  const signal = new AbortController().signal;

  // Агент закоммитил заготовку без задач фазы и был прерван: проверку такой
  // коммит ещё не проходит, но завершить планирование этой сессией можно.
  await writeFile(taskPath, "- [x] 1.1 Готовая задача\n\n## Phase 2\n");
  await git("add", ".");
  await git("commit", "-m", "docs(openspec): начать планирование фазы");
  assert.deepEqual(await service.assess(workspace, plan.session, signal), { kind: "resumable" });

  // Задачи фазы дописаны: сессия остаётся продолжаемой и уже подтверждается.
  await writeFile(taskPath, "- [x] 1.1 Готовая задача\n\n## Phase 2\n\n- [ ] 2.1 Новая задача\n");
  await git("add", ".");
  await git("commit", "-m", "docs(openspec): спланировать задачи фазы");
  assert.deepEqual(await service.assess(workspace, plan.session, signal), { kind: "resumable" });
});
