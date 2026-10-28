import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { renderFindingDecisions } from "../server/review-finding-decision-model.ts";

const execFileAsync = promisify(execFile);
const changeId = "resolve-review-findings";
const parentBranch = `change/${changeId}`;
const branch = parentBranch;
const findingSubject = "Resolve review finding";
const outsideChangePaths = [
  "README.md",
  "docs/adr/0001-export-contract.md",
  "openspec/specs/export/spec.md",
  "openspec/changes/related-change/specs/export/spec.md",
  "src/export.ts",
  "test/export.test.mjs",
];
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

function findingHeading(id) {
  return `${id} · High — Проблема ${id}`;
}

function decision(kind) {
  return kind === "accept-risk"
    ? {
        kind,
        rationale: "Отдельный путь для legacy удваивает стоимость поддержки.",
        scope: "Только legacy tenants до конца миграции.",
        reopenWhen: "Срок миграции будет продлён.",
      }
    : { kind: "remediate", instruction: "Зафиксировать проверяемый контракт в спецификации." };
}

// Файл решений с решением по каждой finding; kinds задаёт вид решения.
function decisionsSource(findingIds, kinds = {}) {
  return renderFindingDecisions(
    "review",
    findingIds.map((id) => ({
      findingId: id,
      heading: findingHeading(id),
      decision: typeof kinds[id] === "object" ? kinds[id] : decision(kinds[id]),
    })),
  );
}

function finding(id) {
  return `### ${findingHeading(id)}

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

async function createRepository(context, findingIds = ["F1", "F3"], {
  decided = findingIds,
  kinds = {},
} = {}) {
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
  const decisionsPath = join(changeRoot, "review-decisions.md");
  if (decided.length > 0) await writeFile(decisionsPath, decisionsSource(decided, kinds));
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
    decisionsPath,
    decisionKinds: kinds,
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

// Сессия исполнения удаляет из файла решений раздел закрытой finding.
async function writeRemainingDecisions(fixture, findingIds) {
  await writeFile(fixture.decisionsPath, decisionsSource(findingIds, fixture.decisionKinds));
}

async function commitResolution(fixture, {
  findingIds = ["F3"],
  acceptedRisks = [],
  subject = findingSubject,
  extraPaths = [],
  push = false,
} = {}) {
  await writeFile(fixture.reviewPath, reviewReport(findingIds, acceptedRisks));
  await writeRemainingDecisions(fixture, findingIds);
  await writeFile(join(fixture.changeRoot, "proposal.md"), "# Предложение\n\nУточнён контракт.\n");
  for (const path of extraPaths) {
    const filePath = join(fixture.workspace, path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, path.endsWith(".md")
      ? "# Исправление замечания\n\nУточнён контракт экспорта.\n"
      : "// Исправление замечания.\n");
  }
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
        async refresh() { return { agent: { status: "idle", archivedAt: null } }; }, async archive() { return { archivedAt: "2026-10-09T00:00:00.000Z" }; },
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
  assert.match(createdOptions.prompt, /Do not ask the user for a decision or an approval/);
  assert.match(createdOptions.prompt, /"decision":\{"kind":"remediate"/);
  assert.match(createdOptions.prompt, /without asking for approval/);
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
  assert.match(firstText(result), /F1.*требуется хотя бы один новый Git-коммит/);

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

  // Решение закрытой finding должно уйти из файла решений в том же диапазоне.
  await execFileAsync("git", ["add", "openspec"], { cwd: fixture.workspace });
  await execFileAsync("git", ["commit", "-m", findingSubject], {
    cwd: fixture.workspace,
  });
  result = await client.callTool({ name: "complete_review_finding", arguments: publishInput });
  assert.equal(result.isError, true);
  assert.match(firstText(result), /Удалите из .*review-decisions\.md раздел finding «F1» и разделы findings/u);

  await writeRemainingDecisions(fixture, ["F3"]);
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
  const fixture = await createRepository(context, ["F1"], { kinds: { F1: "accept-risk" } });
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
      return { id: "agent-risk", async refresh() { return { agent: { status: "idle", archivedAt: null } }; }, async archive() { return { archivedAt: "2026-10-09T00:00:00.000Z" }; }, async waitForFinish() { await runTool; } };
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
  assert.match(createdOptions.prompt, /accept only finding `F1` as residual risk/);
  assert.match(createdOptions.prompt, /acceptance authority/);
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
      return { id: "agent-task-scope", async refresh() { return { agent: { status: "idle", archivedAt: null } }; }, async archive() { return { archivedAt: "2026-10-09T00:00:00.000Z" }; }, async waitForFinish() { await runTool; } };
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
      return { id: `agent-${kind}`, async refresh() { return { agent: { status: "idle", archivedAt: null } }; }, async archive() { return { archivedAt: "2026-10-09T00:00:00.000Z" }; }, async waitForFinish() {} };
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
    extraPaths: kind === "outside" ? outsideChangePaths : [],
  });
  if (kind === "multiple") {
    await writeFile(join(fixture.changeRoot, "design.md"), "# Дизайн\n");
    await execFileAsync("git", ["add", "openspec"], { cwd: fixture.workspace });
    await execFileAsync("git", ["commit", "-m", findingSubject], {
      cwd: fixture.workspace,
    });
  }
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
    const resolution = await running;
    assert.equal(await remoteHead(fixture), resolution.commit);
    assert.match(fixture.pullRequest.body, /OpenSpec review `F1` — исправлено/u);
    if (kind === "outside") {
      for (const path of outsideChangePaths) {
        const { stdout } = await execFileAsync("git", ["show", `${resolution.commit}:${path}`], {
          cwd: fixture.remote,
        });
        assert.equal(stdout, await readFile(join(fixture.workspace, path), "utf8"));
      }
    }
  }
  return result;
}

test("completion tool принимает файлы вне change и несколько коммитов с любыми subject", async (context) => {
  const outside = await commitScenarioResult(context, "outside");
  assert.equal(outside.isError, undefined);

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
      return { id: "agent-checkpoint", async refresh() { return { agent: { status: "idle", archivedAt: null } }; }, async archive() { return { archivedAt: "2026-10-09T00:00:00.000Z" }; }, async waitForFinish() {} };
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, branch);
  await commitResolution(fixture, { findingIds: [], extraPaths: outsideChangePaths, push: true });
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
  assert.match(options.prompt, /Do not invoke the skill and do not create or amend a commit/);
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
  assert.equal(
    fixture.pullRequest.body.match(/paseo-openspec-orchestrator:finding:review:F1:/gu)?.length,
    1,
  );
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
        async refresh() { return { agent: { status: "idle", archivedAt: null } }; }, async archive() { return { archivedAt: "2026-10-09T00:00:00.000Z" }; },
        async waitForFinish() { await toolResult; },
      };
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, branch);
  assert.equal(plan.kind, "finding-required");
  await commitResolution(fixture, { findingIds: [], extraPaths: outsideChangePaths, push: true });
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

function promptInput(overrides = {}) {
  return {
    changeId,
    findingId: "F42",
    baselineCommit: "c".repeat(40),
    findingHeading: findingHeading("F42"),
    decision: decision("remediate"),
    branch,
    reviewRepositoryPath: `openspec/changes/${changeId}/review.md`,
    decisionsRepositoryPath: `openspec/changes/${changeId}/review-decisions.md`,
    recovery: { kind: "none" },
    taskScope: initialScope,
    ...overrides,
  };
}

test("prompt исполняет записанное решение без пользователя, сохраняет задачи и оставляет push оркестратору", () => {
  const prompt = changeFindingResolutionPrompt(promptInput());
  assert.match(prompt, /F42/);
  assert.match(prompt, /You carry out the user's recorded decision on one finding/u);
  assert.match(prompt, /only when a genuine blocker stops you/u);
  assert.match(prompt, /"decision":\{"kind":"remediate","instruction":"Зафиксировать/u);
  assert.match(prompt, /"decisionsPath":"openspec\/changes\/resolve-review-findings\/review-decisions\.md"/u);
  assert.match(prompt, /Do not ask the user for a decision or an approval/u);
  assert.match(prompt, /address only finding `F42` as the recorded decision states/u);
  assert.match(prompt, /Never accept residual risk for a finding the user decided to remediate/u);
  assert.match(prompt, /delete this finding's whole section/u);
  assert.match(prompt, /changes no implementation code and does not complete a plan\.md phase: never run tests, builds, or project checks/u);
  assert.match(prompt, /related repository documentation outside the selected change root/u);
  assert.match(prompt, /ADRs, README files, domain documents, and guides/u);
  assert.match(prompt, /only as needed for the recorded decision on this finding/u);
  assert.match(prompt, /All changed files must stay inside the Git root/u);
  assert.match(prompt, /never edit implementation code, tests, or configuration and never invoke Apply/u);
  assert.match(prompt, /Record requirement changes in the selected change's delta specs; never edit `openspec\/specs` directly/u);
  assert.match(prompt, /synchronizes the main specs when archiving the change/u);
  assert.match(prompt, /Validate the changed OpenSpec artifacts, related documentation, and report state/u);
  assert.match(prompt, /commit only the changed artifacts of the selected change, the decisions file, and the related repository documentation/u);
  assert.doesNotMatch(prompt, /Change only planning artifacts inside the selected change root:|commit only files inside the change root/u);
  assert.doesNotMatch(prompt, /one explicit decision|Get one explicit decision/u);
  assert.match(prompt, /without asking for approval/);
  assert.match(prompt, /never reopen a completed task/);
  // При планировании новые задачи встают в порядке выполнения, а не в конец.
  assert.match(prompt, /add new unfinished tasks/);
  assert.doesNotMatch(prompt, /append new unfinished tasks|Preserve the existing task list exactly/u);
  assert.match(prompt, /strictly in file order/u);
  assert.match(prompt, /may be inserted, reordered, and renumbered/u);
  assert.match(prompt, /Add new tasks only to phases that already have tasks: Phase 1\./u);
  assert.match(prompt, /The orchestrator plans every phase that has no tasks/u);
  assert.match(prompt, /"plannedPhases":\[1\]/u);
  assert.match(prompt, /Do not push/u);
  assert.match(prompt, /complete_review_finding/);
  assert.match(prompt, /"mode":"publish"/);
  assert.match(prompt, /"mode":"blocked","reason"/);
  assert.match(prompt, /without committing anything/);
  assert.match(prompt, /discard your own uncommitted edits with `git restore`/u);
  assert.match(prompt, /the skill needs a choice the decision does not settle/u);
  assert.match(prompt, /user's confirmation of every planning write/u);
  assert.doesNotMatch(prompt, /gh pr/);

  const riskPrompt = changeFindingResolutionPrompt(promptInput({ decision: decision("accept-risk") }));
  assert.match(riskPrompt, /accept only finding `F42` as residual risk/u);
  assert.match(
    riskPrompt,
    /citing the decision entry in `decisionsPath` at commit `c{40}` as the acceptance authority/u,
  );
  assert.match(riskPrompt, /"decisionCommit":"c{40}"/u);

  const recoveredPrompt = changeFindingResolutionPrompt(promptInput({ recovery: { kind: "published" } }));
  assert.match(recoveredPrompt, /"mode":"acknowledge-existing"/);
  assert.match(recoveredPrompt, /Change nothing: do not invoke the skill, commit, or push/);
  assert.doesNotMatch(recoveredPrompt, /git push --set-upstream/);
  assert.doesNotMatch(recoveredPrompt, /Invoke the `openspec-review-change` skill/);
  assert.doesNotMatch(recoveredPrompt, /Add new tasks only/u);
  assert.doesNotMatch(recoveredPrompt, /"mode":"blocked"/u);

  const committedPrompt = changeFindingResolutionPrompt(promptInput({ recovery: { kind: "committed" } }));
  assert.match(committedPrompt, /already absent from a valid committed resolution/u);
  assert.match(committedPrompt, /"mode":"publish"/u);
  assert.doesNotMatch(committedPrompt, /"mode":"blocked"/u);

  const planningPrompt = changeFindingResolutionPrompt(promptInput({
    taskScope: { kind: "phase-planning", phaseNumber: 2 },
  }));
  assert.match(planningPrompt, /Add new tasks only to Phase 2\./u);
  assert.match(planningPrompt, /Never describe an execution order that differs from file order/u);
  assert.match(planningPrompt, /"phaseNumber":2/u);
  assert.match(planningPrompt, /changes no implementation code and does not complete a plan\.md phase: never run tests, builds, or project checks/u);
});

test("оценка finding-сессии различает неначатую, устранённую и устаревшую", async (context) => {
  const fixture = await createRepository(context);
  const { command } = createCommand(fixture);
  const service = createChangeFindingResolutionService({
    command,
    phaseWork: stubPhaseWork(),
    async createAgent() {},
  });
  const signal = new AbortController().signal;
  const git = async (...args) =>
    (await execFileAsync("git", args, { cwd: fixture.workspace })).stdout.trim();
  const assess = (session) =>
    service.assess({ workspaceDirectory: fixture.workspace, session, taskScope: initialScope, signal });

  const plan = await service.plan(fixture.workspace, changeId, branch);
  assert.equal(plan.kind, "finding-required");
  assert.deepEqual(await assess(plan.session), { kind: "resumable" });

  // Незавершённое устранение внутри change продолжает агент той же сессии.
  await writeFile(join(fixture.changeRoot, "proposal.md"), "# Предложение\n\nЧерновик правки.\n");
  await git("add", ".");
  await git("commit", "-m", "docs(openspec): draft resolution");
  assert.deepEqual(await assess(plan.session), { kind: "resumable" });

  // Коммит пользователя с кодом продолжает ту же finding-сессию.
  await writeFile(join(fixture.workspace, "application.ts"), "export const fixed = true;\n");
  await git("add", ".");
  await git("commit", "-m", "fix: ручная правка кода");
  assert.deepEqual(await assess(plan.session), { kind: "resumable" });

  // Готовое устранение принимается с исходным baseline, включая правку кода.
  await commitResolution(fixture);
  assert.deepEqual(await assess(plan.session), { kind: "resumable" });

  // Переписанная история лишает сессию baseline.
  await git("checkout", "--orphan", "rewritten");
  await git("commit", "-m", "переписанная история");
  await git("branch", "-M", branch);
  assert.deepEqual(await assess(plan.session), {
    kind: "stale",
    reason: "Текущий Git HEAD больше не продолжает baseline finding-сессии",
  });
});

function idleAgent(id, waitForFinish = async () => {}) {
  return {
    id,
    async refresh() { return { agent: { status: "idle", archivedAt: null } }; },
    async archive() { return { archivedAt: "2026-10-09T00:00:00.000Z" }; },
    waitForFinish,
  };
}

async function headCommit(fixture) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.workspace });
  return String(stdout).trim();
}

const remediateF1 = {
  findingId: "F1",
  kind: "remediate",
  instruction: "Описать отмену экспорта в спецификации и добавить задачу на проверку отмены.",
};
const acceptF3 = {
  findingId: "F3",
  kind: "accept-risk",
  rationale: "Legacy-топология выводится из эксплуатации до релиза.",
  scope: "Только legacy tenants до конца миграции.",
  reopenWhen: "Миграция legacy tenants будет отложена.",
};

test("plan сначала исполняет принятые решения и собирает решения, только когда их не осталось", async (context) => {
  const fixture = await createRepository(context, ["F1", "F3", "F5"], { decided: ["F3"] });
  const { command } = createCommand(fixture);
  const service = createChangeFindingResolutionService({ command, phaseWork: stubPhaseWork(), async createAgent() {} });

  // F1 идёт в отчёте раньше, но решение есть только у F3.
  const decided = await service.plan(fixture.workspace, changeId, branch);
  assert.equal(decided.kind, "finding-required");
  assert.equal(decided.findingId, "F3");

  // Решение привязано к заголовку: повторный аудит, переформулировавший F3,
  // лишает его силы, и нужна сессия решений по всем открытым findings.
  const reworded = reviewReport(["F1", "F3", "F5"]).replace("Проблема F3", "Другая проблема F3");
  await writeFile(fixture.reviewPath, reworded);
  await execFileAsync("git", ["commit", "-am", "docs(openspec): reword finding"], { cwd: fixture.workspace });
  await execFileAsync("git", ["push", "origin", branch], { cwd: fixture.workspace });
  const undecided = await service.plan(fixture.workspace, changeId, branch);
  assert.equal(undecided.kind, "decisions-required");
  assert.deepEqual(undecided.session, {
    changeId,
    branch,
    findingIds: ["F1", "F3", "F5"],
    baselineCommit: await headCommit(fixture),
  });
});

test("plan останавливается на повреждённом файле решений с объяснением", async (context) => {
  const fixture = await createRepository(context, ["F1"]);
  const { command } = createCommand(fixture);
  const service = createChangeFindingResolutionService({ command, phaseWork: stubPhaseWork(), async createAgent() {} });
  await writeFile(
    fixture.decisionsPath,
    decisionsSource(["F1"]).replace("- **Решение:** Устранить", "- **Решение:** Подумать"),
  );
  await execFileAsync("git", ["commit", "-am", "docs(openspec): edit decisions"], { cwd: fixture.workspace });
  await execFileAsync("git", ["push", "origin", branch], { cwd: fixture.workspace });
  await assert.rejects(
    service.plan(fixture.workspace, changeId, branch),
    /review-decisions\.md: в решении F1 поле «Решение» должно быть одним из/u,
  );
});

test("сессия решений собирает решения по всем findings, а оркестратор коммитит и публикует их", async (context) => {
  const fixture = await createRepository(context, ["F1", "F3"], { decided: [] });
  const { command } = createCommand(fixture);
  const labels = [];
  const recordedCalls = [];
  let options;
  let toolResults;
  const service = createChangeFindingResolutionService({
    command,
    phaseWork: stubPhaseWork(),
    async createAgent(value) {
      options = value;
      toolResults = (async () => {
        const [{ url }] = Object.values(value.config.mcpServers);
        const client = await connectClient(url);
        try {
          const call = (decisions) =>
            client.callTool({ name: "submit_review_finding_decisions", arguments: { decisions } });
          const missing = await call([remediateF1]);
          const foreign = await call([remediateF1, acceptF3, { ...remediateF1, findingId: "F9" }]);
          const english = await call([{ ...remediateF1, instruction: "Fix it" }, acceptF3]);
          await writeFile(join(fixture.changeRoot, "proposal.md"), "# Предложение\n\nПравка агента.\n");
          const dirty = await call([remediateF1, acceptF3]);
          await execFileAsync("git", ["checkout", "--", "."], { cwd: fixture.workspace });
          const accepted = await call([remediateF1, acceptF3]);
          const repeated = await call([remediateF1, acceptF3]);
          return { missing, foreign, english, dirty, accepted, repeated };
        } finally {
          await client.close();
        }
      })();
      return idleAgent("agent-decisions", async () => { await toolResults; });
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });

  const plan = await service.plan(fixture.workspace, changeId, branch);
  assert.equal(plan.kind, "decisions-required");
  assert.deepEqual(await service.assessDecisions({
    workspaceDirectory: fixture.workspace,
    session: plan.session,
    signal: new AbortController().signal,
  }), { kind: "resumable" });

  const recorded = await service.decide({
    workspaceDirectory: fixture.workspace,
    changeId,
    branch,
    profile: highProfile(),
    session: plan.session,
    taskScope: initialScope,
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onDecisionsRecorded(value) { recordedCalls.push(value); },
  });
  const results = await toolResults;

  assert.match(options.title, /Решения по findings review/u);
  assert.deepEqual(options.labels, { ntfy: "true" });
  assert.match(options.prompt, /You collect the user's decisions on all open findings/u);
  assert.match(options.prompt, /Do all of this without asking the user anything/u);
  assert.match(options.prompt, /in one message/u);
  assert.match(options.prompt, /A recommendation is not a decision/u);
  assert.match(options.prompt, /Change no file and create no commit/u);
  assert.match(options.prompt, /"findingIds":\["F1","F3"\]/u);
  assert.match(options.prompt, /Add new tasks only to phases that already have tasks: Phase 1\./u);
  assert.match(options.prompt, /submit_review_finding_decisions/u);
  assert.doesNotMatch(options.prompt, /blockers`, an earlier session/u);

  assert.equal(results.missing.isError, true);
  assert.match(firstText(results.missing), /Нет решения пользователя по findings: F3/u);
  assert.equal(results.foreign.isError, true);
  assert.match(firstText(results.foreign), /вне этой сессии: F9/u);
  assert.equal(results.english.isError, true);
  assert.equal(results.dirty.isError, true);
  assert.match(firstText(results.dirty), /Сессия решений не должна менять файлы/u);
  assert.equal(results.accepted.isError, undefined);
  assert.equal(results.repeated.isError, undefined);

  const head = await headCommit(fixture);
  assert.equal(recorded.commit, head);
  assert.equal(await remoteHead(fixture), head);
  assert.deepEqual(recordedCalls, [recorded]);
  assert.deepEqual(recorded.decisions.map(({ findingId, decision: { kind } }) => [findingId, kind]), [
    ["F1", "remediate"],
    ["F3", "accept-risk"],
  ]);
  assert.deepEqual(labels, [["agent-decisions", false]]);
  const { stdout: subject } = await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd: fixture.workspace });
  assert.equal(String(subject).trim(), "docs(openspec): record review finding decisions");
  const written = await readFile(fixture.decisionsPath, "utf8");
  assert.match(written, /^# Решения по findings OpenSpec review\n/u);
  assert.match(written, /## F1 · High — Проблема F1\n\n- \*\*Решение:\*\* Устранить\n- \*\*Как устранить:\*\* Описать отмену/u);
  assert.match(written, /## F3 · High — Проблема F3\n\n- \*\*Решение:\*\* Принять остаточный риск\n- \*\*Обоснование:\*\* Legacy/u);

  // Записанные решения сразу исполняются: первой идёт F1.
  const next = await service.plan(fixture.workspace, changeId, branch);
  assert.equal(next.kind, "finding-required");
  assert.equal(next.findingId, "F1");
});

test("сессия решений восстанавливается без агента и устаревает при посторонних коммитах", async (context) => {
  const fixture = await createRepository(context, ["F1"], { decided: [] });
  const { command } = createCommand(fixture);
  let agents = 0;
  const service = createChangeFindingResolutionService({
    command,
    phaseWork: stubPhaseWork(),
    async createAgent() {
      agents += 1;
      return idleAgent("agent-unexpected");
    },
    logger: { error() {}, warn() {} },
  });
  const signal = new AbortController().signal;
  const plan = await service.plan(fixture.workspace, changeId, branch);
  assert.equal(plan.kind, "decisions-required");

  // Коммит решений создан, но процесс упал до публикации и checkpoint.
  await writeFile(fixture.decisionsPath, decisionsSource(["F1"]));
  await execFileAsync("git", ["add", "openspec"], { cwd: fixture.workspace });
  await execFileAsync("git", ["commit", "-m", "docs(openspec): record review finding decisions"], { cwd: fixture.workspace });
  const assess = () =>
    service.assessDecisions({ workspaceDirectory: fixture.workspace, session: plan.session, signal });
  assert.deepEqual(await assess(), { kind: "resumable" });

  const recordedCalls = [];
  const recorded = await service.decide({
    workspaceDirectory: fixture.workspace,
    changeId,
    branch,
    profile: highProfile(),
    session: plan.session,
    taskScope: initialScope,
    signal,
    onAgentCreated() {},
    async onDecisionsRecorded(value) { recordedCalls.push(value); },
  });
  assert.equal(agents, 0);
  assert.equal(await remoteHead(fixture), recorded.commit);
  assert.deepEqual(recordedCalls, [recorded]);

  // Посторонняя правка после baseline делает сессию решений устаревшей.
  await writeFile(join(fixture.changeRoot, "proposal.md"), "# Предложение\n\nПравка пользователя.\n");
  await execFileAsync("git", ["commit", "-am", "docs(openspec): manual edit"], { cwd: fixture.workspace });
  const stale = await assess();
  assert.equal(stale.kind, "stale");
  assert.match(stale.reason, /изменены файлы, кроме .*review-decisions\.md/u);
});

test("препятствие возвращает finding к решению пользователя через коммит оркестратора", async (context) => {
  const fixture = await createRepository(context, ["F1", "F3"], { decided: ["F1"] });
  const { command } = createCommand(fixture);
  const blockedReason = "Решение требует удалить публичный API, на который опираются интеграции.";
  let toolResults;
  const service = createChangeFindingResolutionService({
    command,
    phaseWork: stubPhaseWork(),
    async createAgent(value) {
      toolResults = (async () => {
        const [{ url }] = Object.values(value.config.mcpServers);
        const client = await connectClient(url);
        try {
          const call = (argumentsValue) =>
            client.callTool({ name: "complete_review_finding", arguments: argumentsValue });
          const publishWithoutFix = await call(publishInput);
          const blocked = await call({ mode: "blocked", reason: blockedReason });
          const publishAfterBlock = await call(publishInput);
          return { publishWithoutFix, blocked, publishAfterBlock };
        } finally {
          await client.close();
        }
      })();
      return idleAgent("agent-blocked", async () => { await toolResults; });
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, branch);
  assert.equal(plan.findingId, "F1");
  const bodyBefore = fixture.pullRequest.body;
  const completed = [];
  const result = await service.run({
    workspaceDirectory: fixture.workspace,
    changeId,
    branch,
    profile: highProfile(),
    session: plan.session,
    taskScope: initialScope,
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onFindingResolved(value) { completed.push(value); },
  });
  const results = await toolResults;
  assert.equal(results.publishWithoutFix.isError, true);
  assert.equal(results.blocked.isError, undefined);
  // После успешного завершения повторный вызов возвращает тот же итог.
  assert.equal(results.publishAfterBlock.isError, undefined);

  assert.equal(result.outcome, "blocked");
  assert.equal(result.reason, blockedReason);
  assert.deepEqual(result.remainingFindingIds, ["F1", "F3"]);
  assert.deepEqual(completed, [result]);
  assert.equal(await remoteHead(fixture), result.commit);
  assert.equal(fixture.pullRequest.body, bodyBefore);
  const written = await readFile(fixture.decisionsPath, "utf8");
  assert.match(written, /## F1 · High — Проблема F1\n\n- \*\*Решение:\*\* Нужно новое решение\n- \*\*Препятствие:\*\* Решение требует/u);
  const { stdout: subject } = await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd: fixture.workspace });
  assert.equal(String(subject).trim(), "docs(openspec): return review finding F1 for decision");

  // Восстановление после записи препятствия не запускает агента повторно.
  let agents = 0;
  const recovery = createChangeFindingResolutionService({
    command,
    phaseWork: stubPhaseWork(),
    async createAgent() {
      agents += 1;
      return idleAgent("agent-unexpected");
    },
  });
  const recovered = await recovery.run({
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
  assert.equal(agents, 0);
  assert.equal(recovered.outcome, "blocked");
  assert.equal(recovered.reason, blockedReason);

  // Других решений нет: следующий раунд решений получает препятствие F1.
  const next = await service.plan(fixture.workspace, changeId, branch);
  assert.equal(next.kind, "decisions-required");
  assert.deepEqual(next.session.findingIds, ["F1", "F3"]);
  let decisionPrompt;
  const decisionService = createChangeFindingResolutionService({
    command,
    phaseWork: stubPhaseWork(),
    async createAgent(value) {
      decisionPrompt = value.prompt;
      throw new Error("агент недоступен");
    },
    logger: { error() {}, warn() {} },
  });
  await assert.rejects(decisionService.decide({
    workspaceDirectory: fixture.workspace,
    changeId,
    branch,
    profile: highProfile(),
    session: next.session,
    taskScope: initialScope,
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onDecisionsRecorded() {},
  }));
  assert.match(decisionPrompt, /"blockers":\{"F1":"Решение требует удалить публичный API/u);
  assert.match(decisionPrompt, /an earlier session could not carry out the previous decision/u);
});

test("completion tool отклоняет чужие правки решений и непринятый риск", async (context) => {
  for (const scenario of ["foreign-decision", "unrequested-risk"]) {
    const fixture = await createRepository(context, ["F1", "F3"]);
    const { command } = createCommand(fixture);
    const controller = new AbortController();
    let toolResult;
    const service = createChangeFindingResolutionService({
      command,
      phaseWork: stubPhaseWork(),
      async createAgent(value) {
        toolResult = (async () => {
          if (scenario === "foreign-decision") {
            await writeFile(fixture.reviewPath, reviewReport(["F3"]));
            await writeFile(fixture.decisionsPath, decisionsSource(["F3"], { F3: "accept-risk" }));
          } else {
            await writeFile(fixture.reviewPath, reviewReport(["F3"], [acceptedRisk("AR1", "F1")]));
            await writeFile(fixture.decisionsPath, decisionsSource(["F3"]));
          }
          await execFileAsync("git", ["add", "openspec"], { cwd: fixture.workspace });
          await execFileAsync("git", ["commit", "-m", findingSubject], { cwd: fixture.workspace });
          const [{ url }] = Object.values(value.config.mcpServers);
          const client = await connectClient(url);
          try {
            return await client.callTool({ name: "complete_review_finding", arguments: publishInput });
          } finally {
            await client.close();
            controller.abort();
          }
        })();
        return idleAgent(`agent-${scenario}`);
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
    await assert.rejects(running, /Операция отменена/);
    const result = await toolResult;
    assert.equal(result.isError, true);
    assert.match(
      firstText(result),
      scenario === "foreign-decision"
        ? /Удалите из .*review-decisions\.md раздел finding «F1» и разделы findings, которых больше нет в review\.md; решения по открытым findings не меняйте/u
        : /Пользователь решил устранить finding «F1», а не принять её риск/u,
    );
    assert.equal(await remoteHead(fixture), fixture.baselineCommit);
  }
});

test("finding-сессия без записанного решения устаревает", async (context) => {
  const fixture = await createRepository(context, ["F1"], { decided: [] });
  const { command } = createCommand(fixture);
  const service = createChangeFindingResolutionService({ command, phaseWork: stubPhaseWork(), async createAgent() {} });
  const assessment = await service.assess({
    workspaceDirectory: fixture.workspace,
    session: { changeId, branch, findingId: "F1", baselineCommit: fixture.baselineCommit },
    taskScope: initialScope,
    signal: new AbortController().signal,
  });
  assert.deepEqual(assessment, {
    kind: "stale",
    reason: "Для finding «F1» не записано решение пользователя",
  });
});

test("исправление может попутно закрыть другую finding и удалить её решение", async (context) => {
  const fixture = await createRepository(context, ["F1", "F3", "F5"]);
  const { command } = createCommand(fixture);
  let toolResult;
  const service = createChangeFindingResolutionService({
    command,
    phaseWork: stubPhaseWork(),
    async createAgent(value) {
      toolResult = (async () => {
        // Исправление F1 устранило и F3; решение по F5 остаётся.
        await commitResolution(fixture, { findingIds: ["F5"] });
        // Решение по закрытой попутно F3 нельзя оставить в файле.
        await writeRemainingDecisions(fixture, ["F3", "F5"]);
        await execFileAsync("git", ["commit", "-am", findingSubject], { cwd: fixture.workspace });
        const [{ url }] = Object.values(value.config.mcpServers);
        const client = await connectClient(url);
        try {
          const kept = await client.callTool({ name: "complete_review_finding", arguments: publishInput });
          await writeRemainingDecisions(fixture, ["F5"]);
          await execFileAsync("git", ["commit", "-am", findingSubject], { cwd: fixture.workspace });
          const accepted = await client.callTool({ name: "complete_review_finding", arguments: publishInput });
          return { kept, accepted };
        } finally {
          await client.close();
        }
      })();
      return idleAgent("agent-co-resolved", async () => { await toolResult; });
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
  const { kept, accepted } = await toolResult;
  assert.equal(kept.isError, true);
  assert.match(firstText(kept), /разделы findings, которых больше нет в review\.md/u);
  assert.equal(accepted.isError, undefined);
  assert.equal(result.outcome, "resolved");
  assert.deepEqual(result.remainingFindingIds, ["F5"]);
  const next = await service.plan(fixture.workspace, changeId, branch);
  assert.equal(next.findingId, "F5");
});

test("правка решений пользователем во время finding-сессии делает её устаревшей", async (context) => {
  const fixture = await createRepository(context, ["F1", "F3"]);
  const { command } = createCommand(fixture);
  const service = createChangeFindingResolutionService({ command, phaseWork: stubPhaseWork(), async createAgent() {} });
  const plan = await service.plan(fixture.workspace, changeId, branch);
  const assess = () => service.assess({
    workspaceDirectory: fixture.workspace,
    session: plan.session,
    taskScope: initialScope,
    signal: new AbortController().signal,
  });
  assert.deepEqual(await assess(), { kind: "resumable" });

  await writeFile(fixture.decisionsPath, decisionsSource(["F1", "F3"], {
    F1: { kind: "remediate", instruction: "Пользователь выбрал другой способ устранения." },
  }));
  await execFileAsync("git", ["commit", "-am", "docs(openspec): change decision"], { cwd: fixture.workspace });
  assert.deepEqual(await assess(), {
    kind: "stale",
    reason: "Решения по открытым findings изменились после начала finding-сессии",
  });
});

test("plan останавливается до сессии решений, если заголовок finding нельзя связать с решением", async (context) => {
  const fixture = await createRepository(context, ["F1"], { decided: [] });
  const { command } = createCommand(fixture);
  const service = createChangeFindingResolutionService({ command, phaseWork: stubPhaseWork(), async createAgent() {} });
  await writeFile(
    fixture.reviewPath,
    reviewReport(["F1"]).replace("Проблема F1", `Проблема F1 ${"а".repeat(4_000)}`),
  );
  await execFileAsync("git", ["commit", "-am", "docs(openspec): long heading"], { cwd: fixture.workspace });
  await execFileAsync("git", ["push", "origin", branch], { cwd: fixture.workspace });
  await assert.rejects(
    service.plan(fixture.workspace, changeId, branch),
    /Заголовок finding «F1» в review\.md нельзя связать с решением: Заголовок finding длиннее 4000 символов/u,
  );
});

test("отклонённый hook коммит решений не оставляет следов и сообщает причину", async (context) => {
  const fixture = await createRepository(context, ["F1"], { decided: [] });
  const { command } = createCommand(fixture);
  const hookPath = join(fixture.workspace, ".git", "hooks", "pre-commit");
  await writeFile(hookPath, "#!/bin/sh\necho 'markdownlint: строка длиннее 80 символов' >&2\nexit 1\n", { mode: 0o755 });
  let toolResults;
  const service = createChangeFindingResolutionService({
    command,
    phaseWork: stubPhaseWork(),
    async createAgent(value) {
      toolResults = (async () => {
        const [{ url }] = Object.values(value.config.mcpServers);
        const client = await connectClient(url);
        try {
          const call = () => client.callTool({
            name: "submit_review_finding_decisions",
            arguments: { decisions: [remediateF1] },
          });
          const rejected = await call();
          const { stdout: status } = await execFileAsync(
            "git",
            ["status", "--porcelain=v1", "--untracked-files=all"],
            { cwd: fixture.workspace },
          );
          await rm(hookPath);
          const accepted = await call();
          return { rejected, status: String(status), accepted };
        } finally {
          await client.close();
        }
      })();
      return idleAgent("agent-hook", async () => { await toolResults; });
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
  const plan = await service.plan(fixture.workspace, changeId, branch);
  const recorded = await service.decide({
    workspaceDirectory: fixture.workspace,
    changeId,
    branch,
    profile: highProfile(),
    session: plan.session,
    taskScope: initialScope,
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onDecisionsRecorded() {},
  });
  const { rejected, status, accepted } = await toolResults;
  assert.equal(rejected.isError, true);
  assert.match(
    firstText(rejected),
    /Не удалось закоммитить review-decisions\.md: markdownlint: строка длиннее 80 символов/u,
  );
  assert.equal(status, "");
  assert.equal(accepted.isError, undefined);
  assert.equal(await remoteHead(fixture), recorded.commit);
});
