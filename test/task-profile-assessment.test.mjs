import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createTaskProfileService } from "../server/task-profile-assessment.ts";
import { parseTaskProfiles, renderTaskProfiles } from "../server/task-profile-model.ts";

const execFileAsync = promisify(execFile);
const changeId = "selected-change";
const changeBranch = `change/${changeId}`;
const signal = new AbortController().signal;
const tasksMarkdown = `## 1. Реализация
- [x] 1.1 Схема
- [ ] 1.2 Чтение
- [ ] 1.3 Оболочка

## 2. Будущее
- [ ] 2.1 Будущая задача
`;

function highProfile() {
  return {
    id: "profile-high",
    name: "High",
    provider: "codex",
    model: "model-high",
    modeId: "default",
    thinkingOptionId: "high",
  };
}

function record(description, profile, rationale = "Понятная правка по существующему паттерну") {
  return {
    taskNumber: description.split(" ", 1)[0],
    heading: description,
    assignment: { kind: "assessed", profile, rationale },
  };
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "task-profiles-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const remote = join(root, "origin.git");
  const changeRoot = join(workspace, "openspec", "changes", changeId);
  const tasksPath = join(changeRoot, "tasks.md");
  const profilesPath = join(changeRoot, "task-profiles.md");
  await mkdir(changeRoot, { recursive: true });
  const git = async (...args) => (await execFileAsync("git", args, { cwd: workspace })).stdout.trim();
  await execFileAsync("git", ["init", "--bare", remote]);
  await git("init", "-b", changeBranch);
  await git("config", "user.name", "OpenSpec Test");
  await git("config", "user.email", "openspec@example.test");
  await writeFile(tasksPath, tasksMarkdown);
  await git("add", ".");
  await git("commit", "-m", "docs(openspec): plan tasks");
  await git("remote", "add", "origin", remote);
  await git("push", "-u", "origin", changeBranch);
  const baseline = await git("rev-parse", "HEAD");
  const remoteHead = async () =>
    (await git("ls-remote", "--heads", "origin", `refs/heads/${changeBranch}`)).split(/\s/u)[0];

  // Состояние корневого PR, которое тест может изменить до публикации.
  const pullRequest = { isDraft: true };
  const command = async (executable, args, options) => {
    if (executable === "mise" && args.includes("status")) {
      return {
        stdout: JSON.stringify({
          changeName: changeId,
          changeRoot,
          actionContext: { mode: "repo-local", sourceOfTruth: "repo" },
        }),
        stderr: "",
      };
    }
    if (executable === "mise") {
      const tasks = [...(await readFile(tasksPath, "utf8")).matchAll(/^- \[([ x])\] (\d+\.\d+ .+)$/gmu)]
        .map((match, index) => ({ id: `task-${index + 1}`, description: match[2], done: match[1] === "x" }));
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
      return {
        stdout: JSON.stringify({ nameWithOwner: "example/project", url: "https://github.com/example/project" }),
        stderr: "",
      };
    }
    if (executable === "gh" && args[0] === "pr") {
      const pr = {
        number: 41, url: "https://github.com/example/project/pull/41", state: "OPEN", isDraft: pullRequest.isDraft,
        isCrossRepository: false, baseRefName: "main", headRefName: changeBranch,
        headRefOid: await remoteHead(), title: "Change", body: "Описание",
      };
      return { stdout: JSON.stringify(args[1] === "list" ? [pr] : pr), stderr: "" };
    }
    const result = await execFileAsync(executable, args, { cwd: options.cwd, signal: options.signal, encoding: "utf8" });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
  const run = {
    changeId,
    changeBranch,
    implementationBranch: changeBranch,
    phaseNumber: 1,
    runNumber: 1,
    rootBaselineCommit: baseline,
    repository: { host: "github.com", nameWithOwner: "example/project", url: "https://github.com/example/project" },
    publication: { kind: "unreviewed" },
    batch: { kind: "empty", baseCommit: baseline },
  };
  const commitProfiles = async (records, message = "docs(openspec): record task profiles") => {
    await writeFile(profilesPath, renderTaskProfiles(records));
    await git("add", ".");
    await git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { workspace, tasksPath, profilesPath, baseline, git, remoteHead, command, run, commitProfiles, pullRequest };
}

/** Сервис оценки, агент которого выполняет `action` через MCP-клиент. */
function serviceWithAgent(value, action, created = []) {
  return createTaskProfileService({
    command: value.command,
    async createAgent(options) {
      created.push(options);
      const [{ url }] = Object.values(options.config.mcpServers);
      const acting = (async () => {
        const client = new Client({ name: "task-profile-test", version: "1.0.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(url)));
        try { await action(client); } finally { await client.close(); }
      })();
      return {
        id: "profile-agent",
        async refresh() { return { agent: { status: "idle", archivedAt: null } }; },
        async archive() { return { archivedAt: "2026-10-09T00:00:00.000Z" }; },
        async waitForFinish() { await acting; return { status: "idle" }; },
      };
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
}

test("оценке подлежат только незавершённые задачи текущей фазы без действующей оценки", async (context) => {
  const value = await fixture(context);
  const service = serviceWithAgent(value, async () => assert.fail("Агент не нужен"));
  const required = await service.inspect(value.workspace, value.run, signal);
  assert.equal(required.kind, "assessment-required");
  assert.deepEqual(required.session, {
    changeId,
    branch: changeBranch,
    phaseNumber: 1,
    baselineCommit: value.baseline,
    tasks: [
      { number: "1.2", description: "1.2 Чтение" },
      { number: "1.3", description: "1.3 Оболочка" },
    ],
  });

  // Оценка задачи с прежним текстом не действует для изменённой задачи.
  await value.commitProfiles([record("1.2 Чтение", "Medium"), record("1.3 Старая оболочка", "High")]);
  const partial = await service.inspect(value.workspace, value.run, signal);
  assert.deepEqual(partial.session.tasks, [{ number: "1.3", description: "1.3 Оболочка" }]);

  await value.commitProfiles([record("1.2 Чтение", "Medium"), record("1.3 Оболочка", "High")]);
  const assessed = await service.inspect(value.workspace, value.run, signal);
  assert.equal(assessed.kind, "assessed");
  assert.deepEqual(assessed.records.map(({ taskNumber }) => taskNumber), ["1.2", "1.3"]);
});

test("High-агент записывает оценки только после покрытия всех задач сессии", async (context) => {
  const value = await fixture(context);
  const results = [];
  const created = [];
  const service = serviceWithAgent(value, async (client) => {
    const submit = (assessments) => client.callTool({ name: "submit_task_profiles", arguments: { assessments } });
    results.push(await submit([
      { taskNumber: "1.2", profile: "Medium", rationale: "Локальная правка по готовому паттерну" },
    ]));
    results.push(await submit([
      { taskNumber: "1.2", profile: "Medium", rationale: "Локальная правка по готовому паттерну" },
      { taskNumber: "1.3", profile: "High", rationale: "Меняется контракт между модулями" },
    ]));
  }, created);
  const { session } = await service.inspect(value.workspace, value.run, signal);
  const recordedCheckpoints = [];
  const recorded = await service.run({
    workspaceDirectory: value.workspace,
    profile: highProfile(),
    session,
    signal,
    onAgentCreated() {},
    async onProfilesRecorded(result) { recordedCheckpoints.push(result); },
  });

  assert.equal(results[0].isError, true);
  assert.match(results[0].content[0].text, /Нет оценки задач: 1\.3/u);
  assert.equal(results[1].isError, undefined, results[1].content?.[0]?.text);
  assert.match(results[1].content[0].text, /High: 1\.3; Medium: 1\.2/u);
  assert.deepEqual(recordedCheckpoints, [recorded]);
  assert.deepEqual(recorded.records.map(({ taskNumber, assignment }) => [taskNumber, assignment.profile]), [
    ["1.2", "Medium"], ["1.3", "High"],
  ]);

  // Оркестратор коммитит только файл профилей и публикует коммит.
  const head = await value.git("rev-parse", "HEAD");
  assert.equal(recorded.commit, head);
  assert.equal(await value.remoteHead(), head);
  assert.equal(
    await value.git("diff", "--name-only", `${value.baseline}..${head}`),
    `openspec/changes/${changeId}/task-profiles.md`,
  );
  assert.equal(await value.git("log", "-1", "--format=%s"), "docs(openspec): assess task profiles for phase 1");
  assert.deepEqual(parseTaskProfiles(await readFile(value.profilesPath, "utf8")), recorded.records);

  const [options] = created;
  assert.equal(options.config.provider, "codex/model-high");
  assert.equal(options.title, `Профили задач Phase 1: ${changeId}`);
  assert.match(options.prompt, /Decide by who makes the decisions/u);
  assert.match(options.prompt, /High is the default: assign Medium only when you are confident/u);
  assert.match(options.prompt, /never change files or create commits/u);
  assert.ok(options.prompt.includes('"tasks":[{"number":"1.2","description":"1.2 Чтение"},{"number":"1.3","description":"1.3 Оболочка"}]'));
});

test("записанные до перезапуска оценки публикуются без нового агента", async (context) => {
  const value = await fixture(context);
  const service = serviceWithAgent(value, async () => assert.fail("Агент не нужен"));
  const { session } = await service.inspect(value.workspace, value.run, signal);
  assert.deepEqual(await service.assess(value.workspace, session, signal), { kind: "resumable" });
  const commit = await value.commitProfiles([record("1.2 Чтение", "Medium"), record("1.3 Оболочка", "Medium")]);
  assert.deepEqual(await service.assess(value.workspace, session, signal), { kind: "resumable" });

  const recorded = await service.run({
    workspaceDirectory: value.workspace,
    profile: highProfile(),
    session,
    signal,
    onAgentCreated() { assert.fail("Агент не создаётся"); },
    async onProfilesRecorded() {},
  });
  assert.equal(recorded.commit, commit);
  assert.equal(await value.remoteHead(), commit);
});

test("сессия оценки устаревает после посторонних изменений или неполного файла", async (context) => {
  const value = await fixture(context);
  const service = serviceWithAgent(value, async () => assert.fail("Агент не нужен"));
  const { session } = await service.inspect(value.workspace, value.run, signal);

  await value.commitProfiles([record("1.2 Чтение", "Medium")]);
  assert.deepEqual(await service.assess(value.workspace, session, signal), {
    kind: "stale",
    reason: `openspec/changes/${changeId}/task-profiles.md не содержит оценки задач 1.3`,
  });

  await writeFile(value.tasksPath, tasksMarkdown.replace("1.3 Оболочка", "1.3 Новая оболочка"));
  await value.git("commit", "-am", "docs(openspec): reword task");
  const stale = await service.assess(value.workspace, session, signal);
  assert.equal(stale.kind, "stale");
  assert.match(stale.reason, /изменены файлы, кроме .*task-profiles\.md/u);
});

test("эскалация записывается одним коммитом, а повтор не создаёт второй", async (context) => {
  const value = await fixture(context);
  const service = serviceWithAgent(value, async () => assert.fail("Агент не нужен"));
  await value.commitProfiles([record("1.2 Чтение", "Medium"), record("1.3 Оболочка", "High")]);
  const request = {
    workspaceDirectory: value.workspace,
    changeId,
    task: { number: "1.2", description: "1.2 Чтение" },
    reason: "Спецификация противоречит текущему коду",
    signal,
  };
  const commit = await service.recordEscalation(request);
  assert.equal(await value.git("rev-parse", "HEAD"), commit);
  assert.equal(await value.git("log", "-1", "--format=%s"), "docs(openspec): escalate task 1.2 to High");
  const [escalated, untouched] = parseTaskProfiles(await readFile(value.profilesPath, "utf8"));
  assert.deepEqual(escalated.assignment, {
    kind: "escalated",
    rationale: "Понятная правка по существующему паттерну",
    reason: "Спецификация противоречит текущему коду",
  });
  assert.equal(untouched.assignment.profile, "High");

  assert.equal(await service.recordEscalation(request), commit);
  assert.equal(await value.git("rev-parse", "HEAD"), commit);
  await assert.rejects(
    service.recordEscalation({ ...request, task: { number: "1.3", description: "1.3 Оболочка" } }),
    /уже назначен профиль High/u,
  );
});

test("испорченный пользователем файл профилей останавливает выбор задачи с причиной", async (context) => {
  const value = await fixture(context);
  const service = serviceWithAgent(value, async () => assert.fail("Агент не нужен"));
  await value.commitProfiles([record("1.2 Чтение", "Medium")]);
  await writeFile(value.profilesPath, (await readFile(value.profilesPath, "utf8")).replace("**Профиль:** Medium", "**Профиль:** Low"));
  await value.git("commit", "-am", "docs(openspec): break profiles");
  await assert.rejects(
    service.inspect(value.workspace, value.run, signal),
    /task-profiles\.md: в профиле задачи 1\.2 поле «Профиль» должно быть одним из: High, Medium/u,
  );
});

test("повтор после сбоя публикации переиспользует коммит, а профили из репозитория имеют приоритет", async (context) => {
  const value = await fixture(context);
  const results = [];
  const agentAssessments = [
    { taskNumber: "1.2", profile: "Medium", rationale: "Локальная правка по готовому паттерну" },
    { taskNumber: "1.3", profile: "Medium", rationale: "Понятная задача по спецификации" },
  ];
  const service = serviceWithAgent(value, async (client) => {
    const submit = (assessments) => client.callTool({ name: "submit_task_profiles", arguments: { assessments } });
    // PR перестал быть Draft: коммит создан, но не опубликован.
    value.pullRequest.isDraft = false;
    results.push(await submit(agentAssessments));
    value.pullRequest.isDraft = true;
    // Агент передумал, но записанный коммит уже действует.
    results.push(await submit([agentAssessments[0], { ...agentAssessments[1], profile: "High" }]));
  });
  const { session } = await service.inspect(value.workspace, value.run, signal);
  const recorded = await service.run({
    workspaceDirectory: value.workspace, profile: highProfile(), session, signal,
    onAgentCreated() {}, async onProfilesRecorded() {},
  });
  assert.equal(results[0].isError, true);
  assert.match(results[0].content[0].text, /Draft/u);
  assert.equal(results[1].isError, undefined, results[1].content?.[0]?.text);
  assert.match(results[1].content[0].text, /уже записаны в репозитории .* приняты вместо переданных/u);
  assert.deepEqual(recorded.records.map(({ assignment }) => assignment.profile), ["Medium", "Medium"]);
  assert.equal(await value.git("rev-list", "--count", `${value.baseline}..HEAD`), "1");
  assert.equal(await value.remoteHead(), recorded.commit);
});

test("профили, закоммиченные пользователем во время оценки, принимаются без расхождения", async (context) => {
  const value = await fixture(context);
  let result;
  const service = serviceWithAgent(value, async (client) => {
    await value.commitProfiles([record("1.2 Чтение", "High"), record("1.3 Оболочка", "High")]);
    result = await client.callTool({
      name: "submit_task_profiles",
      arguments: { assessments: [
        { taskNumber: "1.2", profile: "Medium", rationale: "Локальная правка" },
        { taskNumber: "1.3", profile: "Medium", rationale: "Локальная правка" },
      ] },
    });
  });
  const { session } = await service.inspect(value.workspace, value.run, signal);
  const recorded = await service.run({
    workspaceDirectory: value.workspace, profile: highProfile(), session, signal,
    onAgentCreated() {}, async onProfilesRecorded() {},
  });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(recorded.records.map(({ assignment }) => assignment.profile), ["High", "High"]);
});

test("переписанный Git hook файл профилей называется причиной ошибки", async (context) => {
  const value = await fixture(context);
  const hook = join(value.workspace, ".git", "hooks", "pre-commit");
  await writeFile(hook, `#!/bin/sh
sed -i 's/Обоснование/Причина/' openspec/changes/${changeId}/task-profiles.md
git add openspec/changes/${changeId}/task-profiles.md
`, { mode: 0o755 });
  let result;
  const service = serviceWithAgent(value, async (client) => {
    result = await client.callTool({
      name: "submit_task_profiles",
      arguments: { assessments: [
        { taskNumber: "1.2", profile: "Medium", rationale: "Локальная правка" },
        { taskNumber: "1.3", profile: "High", rationale: "Общий контракт" },
      ] },
    });
  });
  const { session } = await service.inspect(value.workspace, value.run, signal);
  const controller = new AbortController();
  const running = service.run({
    workspaceDirectory: value.workspace, profile: highProfile(), session, signal: controller.signal,
    onAgentCreated() {}, async onProfilesRecorded() { assert.fail("Оценка не принята"); },
  });
  while (!result) await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(running, /abort/iu);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Git hook изменил task-profiles\.md при коммите/u);
  assert.equal(await value.remoteHead(), value.baseline, "изменённый hook коммит не публикуется");
});

test("задачу, описание которой нельзя записать в файл, отклоняет проверка до запуска агента", async (context) => {
  const value = await fixture(context);
  await writeFile(value.tasksPath, tasksMarkdown.replace("1.3 Оболочка", "1.3 Обо\u0007лочка"));
  await value.git("commit", "-am", "docs(openspec): add control character");
  await value.git("push", "origin", changeBranch);
  const service = serviceWithAgent(value, async () => assert.fail("Агент не нужен"));
  await assert.rejects(
    service.inspect(value.workspace, value.run, signal),
    /Задачу 1\.3 нельзя записать в task-profiles\.md/u,
  );
});
