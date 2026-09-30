import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  changeFindingResolutionPrompt,
  createChangeFindingResolutionService,
} from "../server/change-finding-resolution.ts";
import { classifyPhaseWork, phaseTaskFingerprint } from "../server/phase-work.ts";
import {
  reviewPullRequestBody,
  reviewPullRequestTitle,
} from "../server/change-review-publication.ts";
import { publishReviewFindingOutcome } from "../server/review-finding-publication.ts";

const execFileAsync = promisify(execFile);
const changeId = "resolve-review-findings";
const parentBranch = `change/${changeId}`;
const branch = parentBranch;
const findingSubject = "Resolve review finding";
const publishInput = {
  mode: "publish",
  problem: "Артефакты не фиксировали обязательное поведение.",
  resolution: "Проверяемый контракт зафиксирован в артефактах change.",
};

function highProfile() {
  return {
    id: "profile-high",
    name: "High",
    provider: "codex",
    model: "gpt-6-astra",
    modeId: "default",
    thinkingOptionId: "high",
    featureValues: { web: false },
  };
}

function phaseTask(number, done = false) {
  const id = `task-${number}`;
  const description = `${number} Задача ${number}`;
  return {
    id,
    number,
    description,
    done,
    phaseNumber: Number(number.split(".")[0]),
    fingerprint: phaseTaskFingerprint(id, number, description),
  };
}

function phaseDecision(tasks, previous) {
  return classifyPhaseWork({
    phases: [{ number: 1 }, { number: 2 }],
    tasks,
    schemaName: "spec-driven",
    planPath: `/repo/openspec/changes/${changeId}/plan.md`,
    taskArtifactPaths: [`/repo/openspec/changes/${changeId}/tasks.md`],
  }, previous);
}

// Снимок OpenSpec: у Phase 1 есть задачи, Phase 2 ждёт планирования оркестратором.
function stubPhaseWork(tasks = () => [phaseTask("1.1")]) {
  return {
    async inspect(_workspace, inspectedChangeId, previous) {
      assert.equal(inspectedChangeId, changeId);
      return phaseDecision(tasks(), previous);
    },
  };
}

async function remoteHead(fixture) {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-remote", "--heads", fixture.remote, `refs/heads/${branch}`],
    { encoding: "utf8" },
  );
  return String(stdout).trim().split(/\s+/u)[0];
}

const initialScope = { kind: "initial-planning", plannedPhases: [1] };

function finding(id) {
  return `### ${id} · High — Проблема ${id}

- **Evidence:** Артефакт не определяет обязательное поведение.
- **Impact:** Реализация может выбрать несовместимое поведение.
- **Required change:** Зафиксировать проверяемый контракт.`;
}

function acceptedRisk(id, origin) {
  return `### ${id} · Поддержка legacy-топологии не планируется

- **Evidence:** Legacy-топология остаётся в эксплуатации.
- **Potential impact:** Миграция может потребовать ручного отката.
- **Acceptance rationale:** Дополнительный путь удваивает стоимость поддержки.
- **Scope and assumptions:** Только legacy tenants до конца миграции.
- **Reopen when:** Срок миграции будет продлён.
- **Acceptance authority:** Пользователь явно принял риск.
- **Originating finding:** ${origin}
- **Acceptance lifetime:** Change-scoped`;
}

function reviewReport(findingIds, acceptedRisks = []) {
  const findingsBody = findingIds.length > 0
    ? findingIds.map(finding).join("\n\n")
    : "No unresolved findings remain in the reviewed change artifacts and relevant repository context.";
  const risks = acceptedRisks.length > 0
    ? `\n\n## Accepted risks\n\n${acceptedRisks.join("\n\n")}`
    : "";
  const summary = acceptedRisks.length > 0
    ? `Приняты остаточные риски ${acceptedRisks.map((entry) => /^### (AR\d+)/u.exec(entry)?.[1]).join(", ")}.`
    : findingIds.length > 0
      ? `Требуют решения ${findingIds.join(", ")}.`
      : "Нерешённых findings нет.";
  return `# OpenSpec Change Review: ${changeId}

## Assessment

**Format version:** 1
**Result:** ${findingIds.length > 0 ? "Changes needed" : "No unresolved findings"}
**Coverage status:** Complete
**Summary:** ${summary}
**Validation:** openspec validate выполнен успешно.

## Findings

${findingsBody}${risks}

## Review coverage

Проверены intent, behavioral contract, decisions, work и verification.
`;
}

async function connectClient(url) {
  const client = new Client({ name: "finding-resolution-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

function firstText(result) {
  const content = result.content[0];
  assert.equal(content?.type, "text");
  return content.text;
}

async function createRepository(context, findingIds = ["F1", "F3"]) {
  const root = await mkdtemp(join(tmpdir(), "openspec-finding-resolution-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const remote = join(root, "origin.git");
  await mkdir(workspace);
  await execFileAsync("git", ["init", "-b", branch], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "OpenSpec Test"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "openspec@example.test"], { cwd: workspace });
  const changeRoot = join(workspace, "openspec", "changes", changeId);
  await mkdir(changeRoot, { recursive: true });
  const reviewPath = join(changeRoot, "review.md");
  await writeFile(join(changeRoot, "proposal.md"), "# Предложение\n");
  await writeFile(reviewPath, reviewReport(findingIds));
  await execFileAsync("git", ["add", "openspec"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "docs(openspec): add change review"], { cwd: workspace });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace });
  const baselineCommit = String(stdout).trim();
  await execFileAsync("git", ["init", "--bare", remote], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: workspace });
  await execFileAsync("git", ["push", "--set-upstream", "origin", branch], { cwd: workspace });
  return {
    workspace,
    remote,
    changeRoot,
    reviewPath,
    baselineCommit,
    pullRequest: {
      number: 43,
      url: "https://github.com/example/project/pull/43",
      state: "OPEN",
      isDraft: true,
      isCrossRepository: false,
      baseRefName: "main",
      headRefName: branch,
      headRefOid: baselineCommit,
      title: reviewPullRequestTitle(changeId),
      body: reviewPullRequestBody(changeId),
    },
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
    if (executable === "git" && arguments_[0] === "remote" && arguments_[1] === "get-url") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (executable === "gh") {
      const { stdout } = await execFileAsync(
        "git",
        ["ls-remote", "--heads", fixture.remote, `refs/heads/${branch}`],
        { encoding: "utf8" },
      );
      const remoteHead = String(stdout).trim().split(/\s+/u)[0];
      if (remoteHead) fixture.pullRequest.headRefOid = remoteHead;
      if (arguments_[0] === "auth") return { stdout: "", stderr: "" };
      if (arguments_[0] === "repo") {
        return {
          stdout: JSON.stringify({
            nameWithOwner: "example/project",
            url: "https://github.com/example/project",
          }),
          stderr: "",
        };
      }
      if (arguments_[0] === "pr" && arguments_[1] === "list") {
        return { stdout: JSON.stringify([fixture.pullRequest]), stderr: "" };
      }
      if (arguments_[0] === "pr" && arguments_[1] === "view") {
        return { stdout: JSON.stringify(fixture.pullRequest), stderr: "" };
      }
      if (arguments_[0] === "api") {
        const bodyFile = arguments_[arguments_.indexOf("--input") + 1];
        const payload = JSON.parse(await readFile(bodyFile, "utf8"));
        fixture.pullRequest.body = payload.body;
        fixture.lastBodyFile = bodyFile;
        return { stdout: fixture.pullRequest.url, stderr: "" };
      }
      throw new Error(`Неожиданный вызов gh: ${arguments_.join(" ")}`);
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

async function commitResolution(fixture, {
  findingIds = ["F3"],
  acceptedRisks = [],
  subject = findingSubject,
  extraPath,
  push = false,
} = {}) {
  await writeFile(fixture.reviewPath, reviewReport(findingIds, acceptedRisks));
  await writeFile(join(fixture.changeRoot, "proposal.md"), "# Предложение\n\nУточнён контракт.\n");
  if (extraPath) await writeFile(join(fixture.workspace, extraPath), "посторонний файл\n");
  await execFileAsync("git", ["add", "."], { cwd: fixture.workspace });
  await execFileAsync("git", ["commit", "-m", subject], { cwd: fixture.workspace });
  if (push) await execFileAsync("git", ["push", "origin", branch], { cwd: fixture.workspace });
}

test("plan выбирает первую finding в порядке review и завершает чистый отчёт", async (context) => {
  const fixture = await createRepository(context, ["F7", "F2"]);
  const { command } = createCommand(fixture);
  const service = createChangeFindingResolutionService({ command, phaseWork: stubPhaseWork(), async createAgent() {} });

  assert.deepEqual(await service.plan(fixture.workspace, changeId, branch), {
    kind: "finding-required",
    findingId: "F7",
    session: {
      changeId,
      branch,
      findingId: "F7",
      baselineCommit: fixture.baselineCommit,
    },
  });

  await writeFile(fixture.reviewPath, reviewReport([]));
  await execFileAsync("git", ["add", fixture.reviewPath], { cwd: fixture.workspace });
  await execFileAsync("git", ["commit", "-m", "docs(openspec): clear review findings"], { cwd: fixture.workspace });
  await execFileAsync("git", ["push", "origin", branch], { cwd: fixture.workspace });
  const cleanPlan = await service.plan(fixture.workspace, changeId, branch);
  assert.equal(cleanPlan.kind, "no-findings");
  assert.equal(cleanPlan.reviewPath, `openspec/changes/${changeId}/review.md`);
  assert.match(cleanPlan.headCommit, /^[0-9a-f]{40}$/u);
});

test("High ждёт scoped MCP, а оркестратор публикует проверенный finding-коммит", async (context) => {
  const fixture = await createRepository(context);
  const { command, calls } = createCommand(fixture);
  const created = [];
  const labels = [];
  const completed = [];
  let createdOptions;
  let resolveCreated;
  let drainCalls = 0;
  const agentCreated = new Promise((resolve) => { resolveCreated = resolve; });
  const service = createChangeFindingResolutionService({
    command,
    phaseWork: stubPhaseWork(),
    async createAgent(options) {
      created.push(options);
      createdOptions = options;
      resolveCreated();
      return {
        id: "agent-finding",
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
  assert.equal(plan.kind, "finding-required");
  const running = service.run({
    workspaceDirectory: fixture.workspace,
    changeId,
    branch,
    profile: highProfile(),
    session: plan.session,
    taskScope: initialScope,
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onFindingResolved(result) { completed.push(result); },
  });
  await agentCreated;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(created.length, 1);
  assert.equal(drainCalls, 0);
  assert.deepEqual(labels, []);
  assert.equal(createdOptions.config.provider, "codex/gpt-6-astra");
  assert.equal(createdOptions.config.thinkingOptionId, "high");
  assert.deepEqual(createdOptions.labels, { ntfy: "true" });
  assert.equal("cwd" in createdOptions, false);
  assert.match(createdOptions.prompt, /openspec-review-change/);
  assert.match(createdOptions.prompt, /one explicit decision/);
  assert.match(createdOptions.prompt, /without asking for another approval/);
  assert.match(createdOptions.prompt, /never reopen a completed task/);
  assert.equal(
    calls.some(({ executable, arguments: arguments_ }) =>
      executable === "paseo" || arguments_.includes("commands")),
    false,
  );

  const [{ url }] = Object.values(createdOptions.config.mcpServers);
  const client = await connectClient(url);
  const listedTools = (await client.listTools()).tools;
  assert.deepEqual(listedTools.map(({ name }) => name), [
    "complete_review_finding",
  ]);
  const advertisedInput = JSON.stringify(listedTools[0]?.inputSchema);
  assert.match(advertisedInput, /acknowledge-existing/);
  assert.match(advertisedInput, /problem/);
  assert.match(advertisedInput, /resolution/);

  let result = await client.callTool({ name: "complete_review_finding", arguments: publishInput });
  assert.equal(result.isError, true);
  assert.match(firstText(result), /F1.*всё ещё присутствует/);

  const untrackedPath = join(fixture.workspace, "untracked.txt");
  await writeFile(untrackedPath, "незакоммиченный файл\n");
  result = await client.callTool({ name: "complete_review_finding", arguments: publishInput });
  assert.equal(result.isError, true);
  assert.match(firstText(result), /незакоммиченные или неотслеживаемые/);
  await rm(untrackedPath);

  await writeFile(fixture.reviewPath, reviewReport(["F3"]));
  result = await client.callTool({ name: "complete_review_finding", arguments: publishInput });
  assert.equal(result.isError, true);
  assert.match(firstText(result), /незакоммиченные или неотслеживаемые/);

  await execFileAsync("git", ["add", "openspec"], { cwd: fixture.workspace });
  await execFileAsync("git", ["commit", "-m", findingSubject], {
    cwd: fixture.workspace,
  });
  result = await client.callTool({ name: "complete_review_finding", arguments: publishInput });
  assert.equal(result.isError, undefined);
  await client.close();

  const resolution = await running;
  assert.equal(resolution.findingId, "F1");
  assert.deepEqual(resolution.remainingFindingIds, ["F3"]);
  assert.equal(resolution.outcome, "resolved");
  assert.deepEqual(resolution.pullRequest, {
    number: 43,
    url: "https://github.com/example/project/pull/43",
  });
  assert.match(fixture.pullRequest.body, /OpenSpec review `F1` — исправлено/);
  assert.deepEqual(completed, [resolution]);
  assert.equal(drainCalls, 1);
  assert.deepEqual(labels, [["agent-finding", false]]);
});

test("accepted risk удаляет finding из активного списка", async (context) => {
  const fixture = await createRepository(context, ["F1"]);
  const { command } = createCommand(fixture);
  let createdOptions;
  let runTool;
  const service = createChangeFindingResolutionService({
    command,
    phaseWork: stubPhaseWork(),
    async createAgent(options) {
      createdOptions = options;
      runTool = (async () => {
        await commitResolution(fixture, {
          findingIds: [],
          acceptedRisks: [acceptedRisk("AR1", "F1")],
          push: true,
        });
        const [{ url }] = Object.values(options.config.mcpServers);
        const client = await connectClient(url);
        try {
          return await client.callTool({
            name: "complete_review_finding",
            arguments: publishInput,
          });
        }
        finally { await client.close(); }
      })();
      return { id: "agent-risk", async waitForFinish() { await runTool; } };
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, branch);
  const result = await service.run({
    workspaceDirectory: fixture.workspace,
    changeId,
    branch,
    profile: highProfile(),
    session: plan.session,
    taskScope: initialScope,
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onFindingResolved() {},
  });
  assert.match(createdOptions.prompt, /accepting residual risk/);
  assert.equal((await runTool).isError, undefined);
  assert.deepEqual(result.remainingFindingIds, []);
  assert.equal(result.outcome, "accepted-risk");
  assert.match(fixture.pullRequest.body, /OpenSpec review `F1` — риск принят/);
  assert.match(fixture.pullRequest.body, /\*\*Итог:\*\* Риск принят:/);
});

test("устранение review finding в начальном планировании не добавляет задачи в фазу без задач", async (context) => {
  const fixture = await createRepository(context, ["F1"]);
  const { command } = createCommand(fixture);
  let tasks = [phaseTask("1.1"), phaseTask("2.1")];
  let runTool;
  const service = createChangeFindingResolutionService({
    command,
    phaseWork: stubPhaseWork(() => tasks),
    async createAgent(options) {
      runTool = (async () => {
        await commitResolution(fixture, { findingIds: [] });
        const [{ url }] = Object.values(options.config.mcpServers);
        const client = await connectClient(url);
        try {
          const rejected = await client.callTool({ name: "complete_review_finding", arguments: publishInput });
          const remoteAfterRejection = await remoteHead(fixture);
          const bodyAfterRejection = fixture.pullRequest.body;
          tasks = [phaseTask("1.1"), phaseTask("1.2")];
          const accepted = await client.callTool({ name: "complete_review_finding", arguments: publishInput });
          return { rejected, remoteAfterRejection, bodyAfterRejection, accepted };
        } finally {
          await client.close();
        }
      })();
      return { id: "agent-task-scope", async waitForFinish() { await runTool; } };
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, branch);
  const result = await service.run({
    workspaceDirectory: fixture.workspace,
    changeId,
    branch,
    profile: highProfile(),
    session: plan.session,
    taskScope: initialScope,
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onFindingResolved() {},
  });
  const { rejected, remoteAfterRejection, bodyAfterRejection, accepted } = await runTool;

  assert.equal(rejected.isError, true);
  assert.match(
    firstText(rejected),
    /До первой проверки фаз задачи можно добавлять только в фазы, где они уже были: Phase 1\. Задачи 2\.1 нарушают это правило/u,
  );
  assert.equal(remoteAfterRejection, fixture.baselineCommit);
  assert.doesNotMatch(bodyAfterRejection, /`F1`/u);
  assert.equal(accepted.isError, undefined);
  assert.equal(result.findingId, "F1");
  assert.equal(await remoteHead(fixture), result.commit);
  assert.match(fixture.pullRequest.body, /`F1` — исправлено/u);
});

async function commitScenarioResult(context, kind) {
  const fixture = await createRepository(context, ["F1"]);
  const { command } = createCommand(fixture);
  const controller = new AbortController();
  let options;
  let resolveCreated;
  const created = new Promise((resolve) => { resolveCreated = resolve; });
  const service = createChangeFindingResolutionService({
    command,
    phaseWork: stubPhaseWork(),
    async createAgent(value) {
      options = value;
      resolveCreated();
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
    profile: highProfile(),
    session: plan.session,
    taskScope: initialScope,
    signal: controller.signal,
    onAgentCreated() {},
    async onFindingResolved() {},
  });
  await created;

  await commitResolution(fixture, {
    findingIds: [],
    subject: kind === "wrong-subject"
      ? "docs(openspec): use wrong finding subject"
      : findingSubject,
    extraPath: kind === "outside" ? "outside.md" : undefined,
  });
  if (kind === "multiple") {
    await writeFile(join(fixture.changeRoot, "design.md"), "# Дизайн\n");
    await execFileAsync("git", ["add", "openspec"], { cwd: fixture.workspace });
    await execFileAsync("git", ["commit", "-m", findingSubject], {
      cwd: fixture.workspace,
    });
  }
  await execFileAsync("git", ["push", "origin", branch], { cwd: fixture.workspace });

  const [{ url }] = Object.values(options.config.mcpServers);
  const client = await connectClient(url);
  const result = await client.callTool({
    name: "complete_review_finding",
    arguments: publishInput,
  });
  await client.close();
  if (result.isError) {
    controller.abort();
    await assert.rejects(running, /Операция отменена/);
  } else {
    await running;
  }
  return result;
}

test("completion tool сохраняет границу change и принимает несколько коммитов с любыми subject", async (context) => {
  const outside = await commitScenarioResult(context, "outside");
  assert.equal(outside.isError, true);
  assert.match(firstText(outside), /только файлы выбранного change/);

  const multiple = await commitScenarioResult(context, "multiple");
  assert.equal(multiple.isError, undefined);

  const wrongSubject = await commitScenarioResult(context, "wrong-subject");
  assert.equal(wrongSubject.isError, undefined);
});

test("ошибка checkpoint восстанавливает ntfy и повторный вызов идемпотентен", async (context) => {
  const fixture = await createRepository(context, ["F1"]);
  const { command } = createCommand(fixture);
  const labels = [];
  let options;
  let resolveCreated;
  const created = new Promise((resolve) => { resolveCreated = resolve; });
  let attempts = 0;
  const service = createChangeFindingResolutionService({
    command,
    phaseWork: stubPhaseWork(),
    async createAgent(value) {
      options = value;
      resolveCreated();
      return { id: "agent-checkpoint", async waitForFinish() {} };
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, branch);
  await commitResolution(fixture, { findingIds: [], push: true });
  const running = service.run({
    workspaceDirectory: fixture.workspace,
    changeId,
    branch,
    profile: highProfile(),
    session: plan.session,
    taskScope: initialScope,
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onFindingResolved() {
      attempts += 1;
      if (attempts === 1) throw new Error("checkpoint недоступен");
    },
  });
  await created;
  assert.match(options.prompt, /This is a recovery session/);
  assert.match(options.prompt, /do not request the user's decision again/);
  const [{ url }] = Object.values(options.config.mcpServers);
  const client = await connectClient(url);
  const first = await client.callTool({
    name: "complete_review_finding",
    arguments: publishInput,
  });
  assert.equal(first.isError, true);
  const repeated = await Promise.all([
    client.callTool({ name: "complete_review_finding", arguments: publishInput }),
    client.callTool({ name: "complete_review_finding", arguments: publishInput }),
  ]);
  assert.equal(repeated[0].isError, undefined);
  assert.equal(repeated[1].isError, undefined);
  await client.close();
  await running;
  assert.deepEqual(labels, [
    ["agent-checkpoint", false],
    ["agent-checkpoint", true],
    ["agent-checkpoint", false],
  ]);
  assert.equal(attempts, 2);
});

test("полный restart подтверждает уже проверенную PR-запись без повторной публикации", async (context) => {
  const fixture = await createRepository(context, ["F1"]);
  const { command } = createCommand(fixture);
  let options;
  let toolResult;
  const service = createChangeFindingResolutionService({
    command,
    phaseWork: stubPhaseWork(),
    async createAgent(value) {
      options = value;
      toolResult = (async () => {
        const [{ url }] = Object.values(value.config.mcpServers);
        const client = await connectClient(url);
        try {
          return await client.callTool({
            name: "complete_review_finding",
            arguments: { mode: "acknowledge-existing" },
          });
        } finally {
          await client.close();
        }
      })();
      return {
        id: "agent-restart",
        async waitForFinish() { await toolResult; },
      };
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, branch);
  assert.equal(plan.kind, "finding-required");
  await commitResolution(fixture, { findingIds: [], push: true });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: fixture.workspace,
  });
  await publishReviewFindingOutcome(
    {
      workspaceDirectory: fixture.workspace,
      changeId,
      branch,
      findingId: "F1",
      baselineCommit: plan.session.baselineCommit,
      expectedHead: String(stdout).trim(),
      kind: "review",
      outcome: "resolved",
      input: publishInput,
    },
    command,
  );

  const resolution = await service.run({
    workspaceDirectory: fixture.workspace,
    changeId,
    branch,
    profile: highProfile(),
    session: plan.session,
    taskScope: initialScope,
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onFindingResolved() {},
  });
  assert.equal((await toolResult).isError, undefined);
  assert.equal(resolution.outcome, "resolved");
  assert.match(options.prompt, /"mode":"acknowledge-existing"/);
  assert.doesNotMatch(options.prompt, /git push --set-upstream/);
  assert.equal(
    fixture.pullRequest.body.match(
      /paseo-openspec-orchestrator:finding:review:F1:/gu,
    )?.length,
    1,
  );
});

test("prompt требует одно решение, сохраняет задачи и оставляет push оркестратору", () => {
  const prompt = changeFindingResolutionPrompt({
    changeId,
    findingId: "F42",
    branch,
    reviewRepositoryPath: `openspec/changes/${changeId}/review.md`,
    alreadyCommitted: false,
    publicationAlreadyCompleted: false,
    taskScope: initialScope,
  });
  assert.match(prompt, /F42/);
  assert.match(prompt, /one explicit decision/);
  assert.match(prompt, /without asking for another approval/);
  assert.match(prompt, /never reopen a completed task/);
  assert.match(prompt, /append new unfinished tasks/);
  assert.match(prompt, /Add new tasks only to phases that already have tasks: Phase 1\./u);
  assert.match(prompt, /The orchestrator plans every phase that has no tasks/u);
  assert.match(prompt, /"plannedPhases":\[1\]/u);
  assert.doesNotMatch(prompt, /second explicit permission|third permission/);
  assert.match(prompt, /Do not push/u);
  assert.match(prompt, /complete_review_finding/);
  assert.match(prompt, /"mode":"publish"/);
  assert.doesNotMatch(prompt, /gh pr/);

  const recoveredPrompt = changeFindingResolutionPrompt({
    changeId,
    findingId: "F42",
    branch,
    reviewRepositoryPath: `openspec/changes/${changeId}/review.md`,
    alreadyCommitted: true,
    publicationAlreadyCompleted: true,
    taskScope: initialScope,
  });
  assert.match(recoveredPrompt, /"mode":"acknowledge-existing"/);
  assert.match(recoveredPrompt, /do not invoke the skill, request the user's decision, commit, or push/);
  assert.doesNotMatch(recoveredPrompt, /git push --set-upstream/);
  assert.doesNotMatch(recoveredPrompt, /Invoke the `openspec-review-change` skill/);
  assert.doesNotMatch(recoveredPrompt, /Add new tasks only/u);

  const planningPrompt = changeFindingResolutionPrompt({
    changeId,
    findingId: "F42",
    branch,
    reviewRepositoryPath: `openspec/changes/${changeId}/review.md`,
    alreadyCommitted: false,
    publicationAlreadyCompleted: false,
    taskScope: { kind: "phase-planning", phaseNumber: 2 },
  });
  assert.match(planningPrompt, /Add new tasks only to Phase 2\./u);
  assert.match(planningPrompt, /"phaseNumber":2/u);
});
