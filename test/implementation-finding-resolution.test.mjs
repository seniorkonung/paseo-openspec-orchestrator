import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  createImplementationFindingResolutionService,
  implementationFindingResolutionCommitSubject,
  implementationFindingResolutionPrompt,
} from "../server/implementation-finding-resolution.ts";
import {
  implementationPullRequestTitle,
  renderImplementationSummary,
} from "../server/implementation-publication.ts";

const execFileAsync = promisify(execFile);
const changeId = "resolve-implementation-findings";
const parentBranch = `change/${changeId}`;
const branch = `implementation/${changeId}/phase-1/run-1`;
const reviewedBase = "a".repeat(40);
const reviewedHead = "b".repeat(40);
const publishInput = {
  mode: "publish",
  problem: "Implementation нарушала проверяемый контракт.",
  resolution: "Implementation и её проверка приведены к контракту.",
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

function finding(id) {
  return `### ${id} · High — Проблема ${id}

- **Evidence:** src/export.js подтверждает запрос до сохранения.
- **Evidence revisions:** ["${reviewedHead}"]
- **Impact:** Пользователь может потерять подтверждённый экспорт.
- **Required outcome:** Успех означает доступный экспорт.
- **Earliest source of truth:** implementation/tests
- **Affected artifacts:** ["src/export.js", "openspec/changes/${changeId}/spec.md"]`;
}

function acceptedRisk(id, origin) {
  return `### ${id} · Ручной rollback legacy

- **Evidence:** Legacy deployment не имеет автоматического rollback.
- **Evidence revisions:** ["${reviewedBase}"]
- **Potential impact:** Восстановление занимает больше времени.
- **Acceptance rationale:** Автоматизация дороже ограниченного риска.
- **Scope and assumptions:** Только legacy deployments сентября 2026.
- **Reopen when:** Срок миграции будет продлён.
- **Acceptance authority:** Пользователь явно принял риск.
- **Originating finding:** ${origin}
- **Acceptance lifetime:** Change-scoped`;
}

function reviewReport(findingIds, acceptedRisks = []) {
  const findingsBody = findingIds.length > 0
    ? findingIds.map(finding).join("\n\n")
    : "No unresolved findings remain in the implementation review.";
  const risks = acceptedRisks.length > 0
    ? `\n\n## Accepted risks\n\n${acceptedRisks.join("\n\n")}`
    : "";
  const summary = acceptedRisks.length > 0
    ? `Принят остаточный риск ${acceptedRisks.map((entry) => /^### (AR\d+)/u.exec(entry)?.[1]).join(", ")}.`
    : findingIds.length > 0
      ? `Требуют решения ${findingIds.join(", ")}.`
      : "Нерешённых findings нет.";
  return `# OpenSpec Implementation Review: ${changeId}

## Assessment

**Format version:** 1
**Result:** ${findingIds.length > 0 ? "Changes needed" : "No unresolved findings"}
**Coverage status:** Complete
**Summary:** ${summary}

## Review target

- **Baseline ref:** review-start
- **Base commit:** ${reviewedBase}
- **Reviewed head:** ${reviewedHead}
- **Target commits:** ["${reviewedHead}"]
- **Reviewable paths:** ["src/export.js", "openspec/changes/${changeId}/spec.md"]
- **OpenSpec change:** ${changeId}
- **OpenSpec schema:** spec-driven
- **Target scope:** User-requested bounded range
- **Baseline freshness:** Local ref state; no fetch performed
- **Planning evidence paths:** ["openspec/changes/${changeId}/spec.md"]

## Reviewed increment

### U1 · Сохранять до подтверждения

- **Work items:** ["1.1"]
- **Requirements and scenarios:** ["Export: persisted acknowledgement"]
- **Affected boundary:** Клиенты Export API.
- **Implementation target:** ["src/export.js"]
- **Applicable constraints and non-goals:** Сохранить текущий success contract.

## Pass coverage

| Pass | Status | Evidence or limitation |
|---|---|---|
| Independent decision review | Complete | Изолированный reviewer проверил target. |
| OpenSpec conformance | Complete | Проверены требования и тесты. |
| Code quality | Complete | Проверены ошибки и callers. |

## Findings

${findingsBody}${risks}

## Review coverage

Проверены persistence, failures и callers.
`;
}

async function connectClient(url) {
  const client = new Client({ name: "implementation-finding-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

function firstText(result) {
  const content = result.content[0];
  assert.equal(content?.type, "text");
  return content.text;
}

async function createRepository(context, findingIds = ["F1", "F3"], { report = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "implementation-finding-resolution-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const remote = join(root, "origin.git");
  await mkdir(workspace);
  await execFileAsync("git", ["init", "-b", branch], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "OpenSpec Test"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "openspec@example.test"], { cwd: workspace });
  const changeRoot = join(workspace, "openspec", "changes", changeId);
  await mkdir(changeRoot, { recursive: true });
  const reviewPath = join(changeRoot, "implementation-review.md");
  await writeFile(join(changeRoot, "spec.md"), "# Спецификация\n");
  if (report) await writeFile(reviewPath, reviewReport(findingIds));
  await execFileAsync("git", ["add", "openspec"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "docs(openspec): add implementation review"], { cwd: workspace });
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
      number: 44,
      url: "https://github.com/example/project/pull/44",
      state: "OPEN",
      isDraft: true,
      isCrossRepository: false,
      baseRefName: parentBranch,
      headRefName: branch,
      headRefOid: baselineCommit,
      title: implementationPullRequestTitle(changeId),
      body: renderImplementationSummary({
        changeId,
        changeBranch: parentBranch,
        implementationBranch: branch,
        rootBaselineCommit: reviewedBase,
        repository: {
          host: "github.com",
          nameWithOwner: "example/project",
          url: "https://github.com/example/project",
        },
        publication: { kind: "unpublished" },
        batch: { kind: "empty", baseCommit: reviewedBase },
        lastDeliveryHead: reviewedHead,
        processedFeedbackFingerprints: [],
      }),
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
  subject = implementationFindingResolutionCommitSubject("F1"),
  extraPath,
  push = false,
} = {}) {
  await writeFile(fixture.reviewPath, reviewReport(findingIds, acceptedRisks));
  await writeFile(join(fixture.changeRoot, "spec.md"), "# Спецификация\n\nДобавлена remediation.\n");
  if (extraPath) await writeFile(join(fixture.workspace, extraPath), "посторонний файл\n");
  await execFileAsync("git", ["add", "."], { cwd: fixture.workspace });
  await execFileAsync("git", ["commit", "-m", subject], { cwd: fixture.workspace });
  if (push) await execFileAsync("git", ["push", "origin", branch], { cwd: fixture.workspace });
}

test("plan выбирает первую implementation finding, а отсутствие отчёта считает пустым", async (context) => {
  const fixture = await createRepository(context, ["F7", "F2"]);
  const { command } = createCommand(fixture);
  const service = createImplementationFindingResolutionService({ command, async createAgent() {} });

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

  const missingFixture = await createRepository(context, [], { report: false });
  const missingService = createImplementationFindingResolutionService({
    command: createCommand(missingFixture).command,
    async createAgent() {},
  });
  assert.deepEqual(await missingService.plan(missingFixture.workspace, changeId, branch), {
    kind: "no-findings",
    reviewPath: `openspec/changes/${changeId}/implementation-review.md`,
    headCommit: missingFixture.baselineCommit,
  });
});

test("High завершает implementation finding только после commit и push", async (context) => {
  const fixture = await createRepository(context);
  const { command, calls } = createCommand(fixture);
  const labels = [];
  let createdOptions;
  let resolveCreated;
  const agentCreated = new Promise((resolve) => { resolveCreated = resolve; });
  const service = createImplementationFindingResolutionService({
    command,
    async createAgent(options) {
      createdOptions = options;
      resolveCreated();
      return { id: "agent-implementation-finding", async waitForFinish() { return { status: "idle" }; } };
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
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onFindingResolved() {},
  });
  await agentCreated;

  assert.equal(createdOptions.config.provider, "codex/gpt-6-astra");
  assert.deepEqual(createdOptions.labels, { ntfy: "true" });
  assert.equal("cwd" in createdOptions, false);
  assert.match(createdOptions.prompt, /openspec-review-implementation/);
  assert.match(createdOptions.prompt, /first explicit permission/);
  assert.match(createdOptions.prompt, /separate second explicit permission/);
  assert.equal(
    calls.some(({ executable, arguments: arguments_ }) =>
      executable === "paseo" || arguments_.includes("commands")),
    false,
  );

  const [{ url }] = Object.values(createdOptions.config.mcpServers);
  const client = await connectClient(url);
  assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), [
    "complete_implementation_review_finding",
  ]);

  let result = await client.callTool({
    name: "complete_implementation_review_finding",
    arguments: publishInput,
  });
  assert.equal(result.isError, true);
  assert.match(firstText(result), /F1.*всё ещё присутствует/);

  const untrackedPath = join(fixture.workspace, "untracked-resolution.tmp");
  await writeFile(untrackedPath, "неотслеживаемый файл\n");
  result = await client.callTool({
    name: "complete_implementation_review_finding",
    arguments: publishInput,
  });
  assert.equal(result.isError, true);
  assert.match(firstText(result), /незакоммиченные или неотслеживаемые/);
  await rm(untrackedPath);

  await writeFile(fixture.reviewPath, reviewReport(["F3"]));
  result = await client.callTool({
    name: "complete_implementation_review_finding",
    arguments: publishInput,
  });
  assert.equal(result.isError, true);
  assert.match(firstText(result), /незакоммиченные или неотслеживаемые/);

  await execFileAsync("git", ["add", "openspec"], { cwd: fixture.workspace });
  await execFileAsync("git", ["commit", "-m", implementationFindingResolutionCommitSubject("F1")], {
    cwd: fixture.workspace,
  });
  result = await client.callTool({
    name: "complete_implementation_review_finding",
    arguments: publishInput,
  });
  assert.equal(result.isError, true);
  assert.match(firstText(result), /origin не содержит текущий HEAD/);

  await execFileAsync("git", ["push", "origin", branch], { cwd: fixture.workspace });
  result = await client.callTool({
    name: "complete_implementation_review_finding",
    arguments: publishInput,
  });
  assert.equal(result.isError, undefined);
  await client.close();

  const resolution = await running;
  assert.equal(resolution.findingId, "F1");
  assert.deepEqual(resolution.remainingFindingIds, ["F3"]);
  assert.equal(resolution.outcome, "resolved");
  assert.deepEqual(resolution.pullRequest, {
    number: 44,
    url: "https://github.com/example/project/pull/44",
  });
  assert.match(
    fixture.pullRequest.body,
    /OpenSpec implementation review `F1` — исправлено/,
  );
  assert.deepEqual(labels, [["agent-implementation-finding", false]]);
});

test("explicit accepted risk удаляет implementation finding из активного списка", async (context) => {
  const fixture = await createRepository(context, ["F1"]);
  const { command } = createCommand(fixture);
  let runTool;
  const service = createImplementationFindingResolutionService({
    command,
    async createAgent(options) {
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
            name: "complete_implementation_review_finding",
            arguments: publishInput,
          });
        } finally {
          await client.close();
        }
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
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onFindingResolved() {},
  });
  assert.equal((await runTool).isError, undefined);
  assert.deepEqual(result.remainingFindingIds, []);
  assert.equal(result.outcome, "accepted-risk");
  assert.match(
    fixture.pullRequest.body,
    /OpenSpec implementation review `F1` — риск принят/,
  );
});

async function rejectedCommitResult(context, kind) {
  const fixture = await createRepository(context, ["F1"]);
  const { command } = createCommand(fixture);
  const controller = new AbortController();
  let options;
  let resolveCreated;
  const created = new Promise((resolve) => { resolveCreated = resolve; });
  const service = createImplementationFindingResolutionService({
    command,
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
    signal: controller.signal,
    onAgentCreated() {},
    async onFindingResolved() {},
  });
  await created;

  if (kind === "deleted-report") {
    await rm(fixture.reviewPath);
    await execFileAsync("git", ["add", "openspec"], { cwd: fixture.workspace });
    await execFileAsync("git", ["commit", "-m", implementationFindingResolutionCommitSubject("F1")], {
      cwd: fixture.workspace,
    });
  } else {
    await commitResolution(fixture, {
      findingIds: [],
      subject: kind === "wrong-subject"
        ? "docs(openspec): use wrong implementation subject"
        : implementationFindingResolutionCommitSubject("F1"),
      extraPath: kind === "outside" ? "outside.md" : undefined,
    });
  }
  if (kind === "multiple") {
    await writeFile(join(fixture.changeRoot, "design.md"), "# Дизайн\n");
    await execFileAsync("git", ["add", "openspec"], { cwd: fixture.workspace });
    await execFileAsync("git", ["commit", "-m", implementationFindingResolutionCommitSubject("F1")], {
      cwd: fixture.workspace,
    });
  }
  await execFileAsync("git", ["push", "origin", branch], { cwd: fixture.workspace });

  const [{ url }] = Object.values(options.config.mcpServers);
  const client = await connectClient(url);
  const result = await client.callTool({
    name: "complete_implementation_review_finding",
    arguments: publishInput,
  });
  await client.close();
  controller.abort();
  await assert.rejects(running, /Операция отменена/);
  return result;
}

test("completion tool отклоняет удалённый отчёт, внешний путь, несколько коммитов и неверный subject", async (context) => {
  const deleted = await rejectedCommitResult(context, "deleted-report");
  assert.equal(deleted.isError, true);
  assert.match(firstText(deleted), /implementation-review\.md/);

  const outside = await rejectedCommitResult(context, "outside");
  assert.equal(outside.isError, true);
  assert.match(firstText(outside), /только файлы выбранного change/);

  const multiple = await rejectedCommitResult(context, "multiple");
  assert.equal(multiple.isError, true);
  assert.match(firstText(multiple), /ровно один отдельный Git-коммит/);

  const wrongSubject = await rejectedCommitResult(context, "wrong-subject");
  assert.equal(wrongSubject.isError, true);
  assert.match(firstText(wrongSubject), /implementation finding/);
});

test("ошибка checkpoint восстанавливает ntfy и recovery не повторяет skill", async (context) => {
  const fixture = await createRepository(context, ["F1"]);
  const { command } = createCommand(fixture);
  const labels = [];
  let options;
  let resolveCreated;
  const created = new Promise((resolve) => { resolveCreated = resolve; });
  let attempts = 0;
  const service = createImplementationFindingResolutionService({
    command,
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
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onFindingResolved() {
      attempts += 1;
      if (attempts === 1) throw new Error("checkpoint недоступен");
    },
  });
  await created;
  assert.match(options.prompt, /This is a recovery session/);
  assert.match(options.prompt, /do not request the two approvals again/);
  const [{ url }] = Object.values(options.config.mcpServers);
  const client = await connectClient(url);
  const first = await client.callTool({
    name: "complete_implementation_review_finding",
    arguments: publishInput,
  });
  assert.equal(first.isError, true);
  const second = await client.callTool({
    name: "complete_implementation_review_finding",
    arguments: publishInput,
  });
  assert.equal(second.isError, undefined);
  await client.close();
  await running;
  assert.deepEqual(labels, [
    ["agent-checkpoint", false],
    ["agent-checkpoint", true],
    ["agent-checkpoint", false],
  ]);
});

test("prompt содержит точный skill, два разрешения, commit+push и fallback subject", () => {
  const prompt = implementationFindingResolutionPrompt({
    changeId,
    findingId: "F42",
    branch,
    reviewRepositoryPath: `openspec/changes/${changeId}/implementation-review.md`,
    alreadyCommitted: false,
    publicationAlreadyCompleted: false,
  });
  assert.match(prompt, /openspec-review-implementation/);
  assert.match(prompt, /F42/);
  assert.match(prompt, /first explicit permission/);
  assert.match(prompt, /separate second explicit permission/);
  assert.match(
    prompt,
    /git push --set-upstream origin implementation\/resolve-implementation-findings/,
  );
  assert.match(prompt, /complete_implementation_review_finding/);
  assert.match(prompt, /"mode":"publish"/);
  assert.doesNotMatch(prompt, /gh pr/);
  assert.equal(
    implementationFindingResolutionCommitSubject(`F${"1".repeat(31)}`),
    "docs(openspec): resolve implementation review finding",
  );

  const recoveredPrompt = implementationFindingResolutionPrompt({
    changeId,
    findingId: "F42",
    branch,
    reviewRepositoryPath: `openspec/changes/${changeId}/implementation-review.md`,
    alreadyCommitted: true,
    publicationAlreadyCompleted: true,
  });
  assert.match(recoveredPrompt, /"mode":"acknowledge-existing"/);
  assert.doesNotMatch(recoveredPrompt, /git push --set-upstream/);
  assert.doesNotMatch(
    recoveredPrompt,
    /Invoke the `openspec-review-implementation` skill/,
  );
});
