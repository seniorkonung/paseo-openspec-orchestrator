import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { changeArchivePrompt, createChangeArchiveService } from "../server/change-archive.ts";
import { createChangeArchiveVerification } from "../server/change-archive-verification.ts";
import { createAwaitRootMergeStep } from "../server/workflow/steps/await-root-merge.ts";
import { createArchiveChangeStep } from "../server/workflow/steps/archive-change.ts";
import { createInitialWorkflowState } from "../server/workflow/types.ts";
import { deliverRootCommit } from "../server/root-branch-delivery.ts";

const execFileAsync = promisify(execFile);
const changeId = "archive-change";
const branch = `change/${changeId}`;
const identity = {
  number: 41, url: "https://github.com/example/project/pull/41",
  repositoryHost: "github.com", repositoryNameWithOwner: "example/project",
  repositoryUrl: "https://github.com/example/project", changeBranch: branch,
};
const addedDelta = "## ADDED Requirements\n\n### Requirement: Архив\nСистема MUST хранить архив.\n\n#### Scenario: Готово\n- **WHEN** работа завершена\n- **THEN** архив доступен\n";
const addedMain = "# API\n\n## Requirements\n\n### Requirement: Архив\nСистема MUST хранить архив.\n\n#### Scenario: Готово\n- **WHEN** работа завершена\n- **THEN** архив доступен\n";

async function fixture(context, { delta = addedDelta, metadata = "schema: spec-driven\n" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "openspec-archive-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "workspace");
  const source = join(directory, "openspec", "changes", changeId);
  await mkdir(join(source, "specs", "api"), { recursive: true });
  const git = async (...args) => (await execFileAsync("git", args, { cwd: directory })).stdout.trim();
  await git("init", "-b", branch);
  await git("config", "user.name", "OpenSpec Test");
  await git("config", "user.email", "openspec@example.test");
  await writeFile(join(source, "tasks.md"), "- [x] 1.1 Готово\n");
  await writeFile(join(source, ".openspec.yaml"), metadata);
  await writeFile(join(source, "specs", "api", "spec.md"), delta);
  await git("add", ".");
  await git("commit", "-m", "docs(openspec): add completed change");
  const baseline = await git("rev-parse", "HEAD");
  const remote = join(root, "origin.git");
  await execFileAsync("git", ["init", "--bare", remote]);
  await git("remote", "add", "origin", remote);
  await git("push", "-u", "origin", branch);
  let totalTasks = 1;
  let completedTasks = 1;
  let artifactStatus = "done";
  let pushCount = 0;
  const command = async (executable, args, options = {}) => {
    if (executable === "mise") {
      const active = await exists(source);
      return { stdout: JSON.stringify({ changes: active ? [{ name: changeId, totalTasks, completedTasks }] : [] }), stderr: "" };
    }
    if (executable === "git" && args.join(" ") === "remote get-url origin") return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    if (executable === "gh" && args[0] === "auth") return { stdout: "", stderr: "" };
    if (executable === "gh" && args[0] === "repo") return { stdout: JSON.stringify({ nameWithOwner: "example/project", url: "https://github.com/example/project" }), stderr: "" };
    if (executable === "gh" && args[0] === "pr") {
      const remoteHead = (await git("ls-remote", "--heads", "origin", `refs/heads/${branch}`)).split(/\s/u)[0];
      const pr = { number: 41, url: identity.url, state: "OPEN", isDraft: true, isCrossRepository: false,
        baseRefName: "main", headRefName: branch, headRefOid: remoteHead, mergeCommit: null, title: "Change", body: "Описание" };
      return { stdout: JSON.stringify(args[1] === "list" ? [pr] : pr), stderr: "" };
    }
    if (executable === "git" && args[0] === "push") pushCount++;
    const result = await execFileAsync(executable, args, { cwd: options.cwd, signal: options.signal });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
  const rootPullRequest = {
    async synchronize() { return baseline; },
    async inspect() { return { kind: "open", isDraft: true, head: await git("rev-parse", "HEAD"), identity }; },
  };
  const statusGateway = {
    async read() { return { gitRoot: directory, changeRoot: source,
      artifacts: new Map([["proposal", { status: artifactStatus }]]),
      artifactPaths: new Map([["specs", { existingOutputPaths: [join(source, "specs", "api", "spec.md")] }]]) }; },
  };
  const verification = createChangeArchiveVerification({ rootPullRequest, command, statusGateway, now: () => new Date("2026-09-25T12:00:00Z") });
  const archive = async (session, { sync = true, extra = false, mainSpec = addedMain } = {}) => {
    const target = join(directory, session.archivePath);
    await mkdir(join(directory, "openspec", "changes", "archive"), { recursive: true });
    if (sync) {
      const spec = join(directory, "openspec", "specs", "api", "spec.md");
      await mkdir(join(directory, "openspec", "specs", "api"), { recursive: true });
      await writeFile(spec, mainSpec);
    }
    await rename(source, target);
    if (extra) await writeFile(join(directory, "unexpected.txt"), "изменение\n");
    await git("add", "-A");
    await git("commit", "-m", "chore(openspec): archive change");
    return await git("rev-parse", "HEAD");
  };
  return {
    directory, source, baseline, git, command, rootPullRequest, verification, archive,
    get pushCount() { return pushCount; },
    setCounts(total, completed) { totalTasks = total; completedTasks = completed; },
    setArtifact(status) { artifactStatus = status; },
  };
}

async function exists(path) {
  try { await execFileAsync("test", ["-e", path]); return true; } catch { return false; }
}

test("архив проверяет задачи, артефакты, перенос файлов и синхронизацию specs", async (context) => {
  const f = await fixture(context);
  assert.equal(await f.verification.inspectRecovery(f.directory, { changeId, branch, baselineCommit: f.baseline, sourcePath: `openspec/changes/${changeId}`, archivePath: `openspec/changes/archive/2026-09-25-${changeId}`, deltaSpecPaths: ["specs/api/spec.md"], rootPullRequest: identity }), "fresh");
  const session = await f.verification.plan(f.directory, changeId, identity);
  assert.equal(session.archivePath, `openspec/changes/archive/2026-09-25-${changeId}`);
  const head = await f.archive(session);
  assert.equal(await f.verification.inspectRecovery(f.directory, session), "committed");
  const result = await f.verification.verifyCommit(f.directory, session);
  assert.equal(result.commit, head);
  await f.verification.verifyArchived(f.directory, result);
  assert.match(changeArchivePrompt(session, "fresh"), /openspec-archive-change/u);
  assert.match(changeArchivePrompt(session, "committed"), /Do not invoke the skill/u);
  assert.match(changeArchivePrompt(session, "fresh"), /Never choose 'Archive without syncing'/u);
});

test("архивация останавливается при незавершённых задачах, артефактах и занятом пути", async (context) => {
  const f = await fixture(context);
  f.setCounts(2, 1);
  await assert.rejects(f.verification.plan(f.directory, changeId, identity), /задач/u);
  f.setCounts(1, 1);
  f.setArtifact("ready");
  await assert.rejects(f.verification.plan(f.directory, changeId, identity), /артефакты/u);
  f.setArtifact("done");
  await mkdir(join(f.directory, "openspec", "changes", "archive", `2026-09-25-${changeId}`), { recursive: true });
  await assert.rejects(f.verification.plan(f.directory, changeId, identity), /уже существует/u);
});

test("архивация отвергает символьную ссылку вместо каталога archive", async (context) => {
  const f = await fixture(context);
  await symlink(f.source, join(f.directory, "openspec", "changes", "archive"));
  await assert.rejects(f.verification.plan(f.directory, changeId, identity), /archive небезопасен/u);
});

test("нерешённая finding не запускает архивного агента", async (context) => {
  context.mock.method(console, "error", () => {});
  let planned = false;
  const step = createArchiveChangeStep({ workspaceDirectory: "/repo",
    readAgentProfiles: async () => { throw new Error("Профиль не нужен"); },
    archive: { async plan() { planned = true; throw new Error("Не должен вызываться"); } },
    phaseWork: { async inspect() { return { kind: "change-complete", progress: { phases: [{ number: 1 }], tasks: [{ done: true, number: "1.1" }], nextImplementationRun: 2 } }; } },
    changeFindings: { async plan() { return { kind: "finding-required" }; } },
    implementationFindings: { async plan() { return { kind: "no-findings" }; } },
  });
  const result = await step.run({ signal: new AbortController().signal,
    state: { ...createInitialWorkflowState(), change: { id: changeId }, changeBranch: branch, activeBranch: branch,
      rootPullRequest: identity, phaseProgress: { phases: [{ number: 1 }], tasks: [{ done: true, number: "1.1" }], nextImplementationRun: 2 } },
    updateActionLinks() {}, async checkpointState() {}, async notify() { return true; } });
  assert.equal(result.kind, "halt");
  assert.match(result.summary, /findings/u);
  assert.equal(planned, false);
});

test("архивный коммит отклоняется без sync и при изменении постороннего файла", async (context) => {
  const f = await fixture(context);
  const session = await f.verification.plan(f.directory, changeId, identity);
  await f.archive(session, { sync: false, extra: true });
  await assert.rejects(f.verification.verifyCommit(f.directory, session), /посторонний путь/u);
});

test("архивный коммит не публикуется в заменённый корневой PR", async (context) => {
  const f = await fixture(context);
  const session = await f.verification.plan(f.directory, changeId, identity);
  const commit = await f.archive(session);
  await assert.rejects(deliverRootCommit(f.directory, changeId, session.baselineCommit, commit, undefined, f.command,
    { ...identity, number: 42 }), /Identity корневого PR изменилась/u);
  assert.equal(f.pushCount, 0);
});

test("архивный коммит отклоняется, если delta spec не появился в основных specs", async (context) => {
  const f = await fixture(context);
  const session = await f.verification.plan(f.directory, changeId, identity);
  await f.archive(session, { sync: false });
  await assert.rejects(f.verification.verifyCommit(f.directory, session), /основной spec отсутствует/u);
});

test("проверка распознаёт переименование требования и разрешённое удаление capability", async (context) => {
  const renamed = await fixture(context, { delta: "## RENAMED Requirements\n\n- FROM: `### Requirement: Старое имя`\n- TO: `### Requirement: Новое имя`\n" });
  const renameSession = await renamed.verification.plan(renamed.directory, changeId, identity);
  await renamed.archive(renameSession, { mainSpec: "## Requirements\n\n### Requirement: Новое имя\nОписание.\n" });
  await renamed.verification.verifyCommit(renamed.directory, renameSession);

  const retired = await fixture(context, { delta: "## REMOVED Requirements\n\n### Requirement: Старое имя\n", metadata: "schema: spec-driven\nretire_capabilities: true\n" });
  const retireSession = await retired.verification.plan(retired.directory, changeId, identity);
  await retired.archive(retireSession, { sync: false });
  await retired.verification.verifyCommit(retired.directory, retireSession);
});

test("Retry различает частичную синхронизацию, перенос и готовый коммит", async (context) => {
  const f = await fixture(context);
  const session = await f.verification.plan(f.directory, changeId, identity);
  assert.equal(await f.verification.inspectRecovery(f.directory, session), "fresh");
  const main = join(f.directory, "openspec", "specs", "api", "spec.md");
  await mkdir(join(f.directory, "openspec", "specs", "api"), { recursive: true });
  await writeFile(main, "## Requirements\n");
  assert.equal(await f.verification.inspectRecovery(f.directory, session), "partial");
  await mkdir(join(f.directory, "openspec", "changes", "archive"), { recursive: true });
  await rename(f.source, join(f.directory, session.archivePath));
  assert.equal(await f.verification.inspectRecovery(f.directory, session), "partial");
});

test("после архивации финальный gate ждёт merge и не читает active change", async (context) => {
  const f = await fixture(context);
  const session = await f.verification.plan(f.directory, changeId, identity);
  const commit = await f.archive(session);
  const archivedChange = { session, commit };
  let merged = false;
  let ready = false;
  let observedHead = commit;
  const step = createAwaitRootMergeStep({
    workspaceDirectory: f.directory,
    archive: { verifyArchived: (...args) => f.verification.verifyArchived(...args) },
    rootPullRequest: {
      async synchronize() { return observedHead; },
      async inspect() { return merged ? { kind: "merged", head: commit, identity } : { kind: "open", isDraft: !ready, head: commit, identity }; },
      async makeReady() { ready = true; return { kind: "open", isDraft: false, head: commit, identity }; },
    },
  });
  const state = { ...createInitialWorkflowState(), change: { id: changeId }, changeBranch: branch, activeBranch: branch, rootPullRequest: identity, archivedChange };
  const contextFor = () => ({ signal: new AbortController().signal, state, updateActionLinks() {}, async checkpointState() {}, async notify() { return true; } });
  const waiting = await step.run(contextFor());
  assert.equal(waiting.kind, "halt");
  assert.equal(ready, true);
  observedHead = "f".repeat(40);
  assert.match((await step.run(contextFor())).summary, /изменилась/u);
  observedHead = commit;
  merged = true;
  assert.equal((await step.run(contextFor())).kind, "complete");
});

test("High-агент завершает архив через scoped MCP, а Retry после push не создаёт второй коммит", async (context) => {
  const f = await fixture(context);
  const session = await f.verification.plan(f.directory, changeId, identity);
  const prompts = [];
  const toolResults = [];
  let archiveCalls = 0;
  const service = createChangeArchiveService({
    command: f.command,
    verification: f.verification,
    rootPullRequest: f.rootPullRequest,
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      return {
        id: "archive-agent",
        async commands() { return { commands: [{ name: "openspec-archive-change" }, { name: "openspec-sync-specs" }], error: null }; },
        async send(prompt) {
          prompts.push(prompt);
          if (archiveCalls === 0) { await f.archive(session); archiveCalls++; }
          const client = new Client({ name: "archive-test", version: "1.0.0" });
          await client.connect(new StreamableHTTPClientTransport(new URL(url)));
          try { toolResults.push(await client.callTool({ name: "complete_change_archive", arguments: {} })); }
          finally { await client.close(); }
        },
        async waitForFinish() { return { status: "idle" }; },
      };
    },
  });
  const request = { workspaceDirectory: f.directory,
    profile: { id: "profile-high", name: "High", provider: "codex", model: "gpt-6-astra", modeId: "default", thinkingOptionId: "high" },
    session, signal: new AbortController().signal, onAgentCreated() {} };
  const first = await service.run(request);
  const second = await service.run(request);
  assert.equal(first.commit, second.commit);
  assert.equal(f.pushCount, 1);
  assert.equal(archiveCalls, 1);
  assert.equal(toolResults.every((result) => result.isError !== true), true);
  assert.match(prompts[0], /openspec-archive-change/u);
  assert.match(prompts[1], /Do not invoke the skill/u);
  assert.equal((await f.git("ls-remote", "--heads", "origin", `refs/heads/${branch}`)).split(/\s/u)[0], first.commit);
});

test("этап останавливается до отправки задания, если archive skill не загружен", async (context) => {
  const f = await fixture(context);
  const session = await f.verification.plan(f.directory, changeId, identity);
  const service = createChangeArchiveService({
    command: f.command, verification: f.verification, rootPullRequest: f.rootPullRequest,
    updateNotificationLabel: async () => {},
    async createAgent() {
      return { id: "archive-agent", async commands() { return { commands: [], error: null }; },
        async send() { throw new Error("Задание не должно отправляться"); },
        async waitForFinish() { return { status: "idle" }; } };
    },
  });
  await assert.rejects(service.run({ workspaceDirectory: f.directory,
    profile: { id: "profile-high", name: "High", provider: "codex", model: "gpt-6-astra", modeId: "default", thinkingOptionId: "high" },
    session, signal: new AbortController().signal, onAgentCreated() {} }), /обязательный skill openspec-archive-change/u);
  assert.equal(await exists(f.source), true);
});
