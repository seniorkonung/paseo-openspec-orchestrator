import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createChangeArtifactCreationService } from "../server/change-artifact-creation.ts";

const execFileAsync = promisify(execFile);

async function connectClient(url) {
  const client = new Client({ name: "change-artifact-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

function firstText(result) {
  const content = result.content[0];
  assert.equal(content?.type, "text");
  return content.text;
}

function ultraProfile() {
  return {
    id: "profile-ultra",
    name: "Ultra",
    provider: "codex",
    model: "gpt-6-astra",
    modeId: "default",
    thinkingOptionId: "ultra",
    featureValues: { web: false },
  };
}

async function createRepository(context) {
  const workspace = await mkdtemp(join(tmpdir(), "openspec-artifacts-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-b", "feature/artifacts"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "OpenSpec Test"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["config", "user.email", "openspec@example.test"], {
    cwd: workspace,
  });
  const changeRoot = join(workspace, "openspec", "changes", "custom-change");
  await mkdir(changeRoot, { recursive: true });
  const foundationPath = join(changeRoot, "foundation.md");
  await writeFile(foundationPath, "# Основание\n");
  await execFileAsync("git", ["add", "openspec"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "docs(openspec): add change scaffold"], {
    cwd: workspace,
  });
  return {
    workspace,
    changeRoot,
    foundationPath,
    riskPath: join(changeRoot, "risk-map.md"),
  };
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultStatus(fixture) {
  const riskExists = await fileExists(fixture.riskPath);
  return {
    changeName: "custom-change",
    schemaName: "custom-assurance",
    planningHome: {
      kind: "repo-local",
      root: fixture.workspace,
      changesDir: join(fixture.workspace, "openspec", "changes"),
      defaultSchema: "custom-assurance",
    },
    changeRoot: fixture.changeRoot,
    artifactPaths: {
      foundation: {
        outputPath: "foundation.md",
        resolvedOutputPath: fixture.foundationPath,
        existingOutputPaths: [fixture.foundationPath],
      },
      "risk-map": {
        outputPath: "risk-map.md",
        resolvedOutputPath: fixture.riskPath,
        existingOutputPaths: riskExists ? [fixture.riskPath] : [],
      },
    },
    nextSteps: riskExists ? [] : ["risk-map"],
    actionContext: {
      mode: "repo-local",
      sourceOfTruth: "repo",
      planningArtifacts: [],
      linkedContext: [],
      allowedEditRoots: [fixture.changeRoot],
      requiresAffectedAreaSelection: false,
      constraints: [],
    },
    isPlanningComplete: riskExists,
    isComplete: riskExists,
    applyRequires: ["risk-map"],
    artifacts: [
      {
        id: "foundation",
        outputPath: "foundation.md",
        status: "done",
        requires: [],
      },
      {
        id: "risk-map",
        outputPath: "risk-map.md",
        status: riskExists ? "done" : "ready",
        requires: ["foundation"],
      },
    ],
    root: { path: fixture.workspace, source: "repo" },
  };
}

function createCommand(fixture, options = {}) {
  const calls = [];
  const command = async (executable, arguments_, commandOptions = {}) => {
    if (executable === "mise") {
      calls.push({ arguments: [...arguments_], options: commandOptions });
      assert.deepEqual(arguments_.slice(0, 5), [
        "exec",
        "--no-deps",
        "--",
        "openspec",
        arguments_[4],
      ]);
      assert.equal(commandOptions.cwd, fixture.workspace);
      assert.equal(commandOptions.env.MISE_EXEC_AUTO_INSTALL, "0");
      if (arguments_[4] === "status") {
        const status = options.status
          ? await options.status()
          : await defaultStatus(fixture);
        return { stdout: JSON.stringify(status), stderr: "" };
      }
      if (arguments_[4] === "instructions" && arguments_[5] === "apply") {
        return {
          stdout: JSON.stringify({
            changeName: "custom-change",
            schemaName: "custom-assurance",
            state: options.applyState ?? "ready",
            ...(options.applyState === "blocked"
              ? { missingArtifacts: ["risk-map"] }
              : {}),
          }),
          stderr: "",
        };
      }
      throw new Error(`Неожиданная команда mise: ${arguments_.join(" ")}`);
    }
    const result = await execFileAsync(executable, [...arguments_], {
      cwd: commandOptions.cwd,
      env: commandOptions.env,
      signal: commandOptions.signal,
      encoding: "utf8",
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
  return { command, calls };
}

test("выбирает первый ready-артефакт нестандартной схемы в порядке OpenSpec", async (context) => {
  const fixture = await createRepository(context);
  const releasePath = join(fixture.changeRoot, "release-notes.md");
  const handoffPath = join(fixture.changeRoot, "handoff.md");
  const { command, calls } = createCommand(fixture, {
    async status() {
      const base = await defaultStatus(fixture);
      return {
        ...base,
        artifactPaths: {
          ...base.artifactPaths,
          "release-notes": {
            outputPath: "release-notes.md",
            resolvedOutputPath: releasePath,
            existingOutputPaths: [],
          },
          handoff: {
            outputPath: "handoff.md",
            resolvedOutputPath: handoffPath,
            existingOutputPaths: [],
          },
        },
        applyRequires: ["handoff"],
        artifacts: [
          base.artifacts[0],
          base.artifacts[1],
          {
            id: "release-notes",
            outputPath: "release-notes.md",
            status: "skipped",
            requires: ["foundation"],
          },
          {
            id: "handoff",
            outputPath: "handoff.md",
            status: "blocked",
            requires: ["risk-map"],
            missingDeps: ["risk-map"],
          },
        ],
      };
    },
  });
  const service = createChangeArtifactCreationService({
    command,
    async createAgent() {
      throw new Error("Агент не должен создаваться при inspect");
    },
  });

  assert.deepEqual(await service.inspect(fixture.workspace, "custom-change"), {
    kind: "next-artifact",
    schemaName: "custom-assurance",
    artifactId: "risk-map",
  });
  assert.deepEqual(calls[0].arguments, [
    "exec",
    "--no-deps",
    "--",
    "openspec",
    "status",
    "--change",
    "custom-change",
    "--json",
  ]);
});

test("отклоняет несогласованный граф и путь артефакта вне change", async (context) => {
  const fixture = await createRepository(context);
  let mode = "graph";
  const { command } = createCommand(fixture, {
    async status() {
      const status = await defaultStatus(fixture);
      if (mode === "graph") {
        status.artifacts[1] = {
          ...status.artifacts[1],
          status: "blocked",
          missingDeps: ["foundation"],
        };
      } else {
        status.artifactPaths["risk-map"].resolvedOutputPath = join(
          fixture.workspace,
          "outside.md",
        );
      }
      return status;
    },
  });
  const service = createChangeArtifactCreationService({
    command,
    async createAgent() {
      throw new Error("Агент не должен создаваться при inspect");
    },
  });

  const graphDecision = await service.inspect(fixture.workspace, "custom-change");
  assert.equal(graphDecision.kind, "inconsistent");
  assert.match(graphDecision.message, /несогласованные missingDeps/);
  mode = "path";
  const pathDecision = await service.inspect(fixture.workspace, "custom-change");
  assert.equal(pathDecision.kind, "inconsistent");
  assert.match(pathDecision.message, /за пределами change/);
});

test("несовместимый status JSON возвращает типизированное inconsistent", async () => {
  const service = createChangeArtifactCreationService({
    async command(executable) {
      assert.equal(executable, "mise");
      return { stdout: '{"changeName":"custom-change"}', stderr: "" };
    },
    async createAgent() {
      throw new Error("Агент не должен создаваться при inspect");
    },
  });

  assert.deepEqual(await service.inspect("/workspace", "custom-change"), {
    kind: "inconsistent",
    message: "OpenSpec вернул некорректный статус change «custom-change»",
  });
});

test("проверка apply принимает ready и all_done, но отклоняет blocked", async (context) => {
  const fixture = await createRepository(context);
  const readyCommand = createCommand(fixture, { applyState: "ready" });
  const readyService = createChangeArtifactCreationService({
    command: readyCommand.command,
    async createAgent() {
      throw new Error("Агент не нужен для проверки apply");
    },
  });
  await readyService.verifyApply(
    fixture.workspace,
    "custom-change",
    "custom-assurance",
  );

  const allDoneCommand = createCommand(fixture, { applyState: "all_done" });
  const allDoneService = createChangeArtifactCreationService({
    command: allDoneCommand.command,
    async createAgent() {
      throw new Error("Агент не нужен для проверки apply");
    },
  });
  await allDoneService.verifyApply(
    fixture.workspace,
    "custom-change",
    "custom-assurance",
  );

  const blockedCommand = createCommand(fixture, { applyState: "blocked" });
  const blockedService = createChangeArtifactCreationService({
    command: blockedCommand.command,
    async createAgent() {
      throw new Error("Агент не нужен для проверки apply");
    },
  });
  await assert.rejects(
    blockedService.verifyApply(
      fixture.workspace,
      "custom-change",
      "custom-assurance",
    ),
    /Apply заблокирован.*risk-map/,
  );
});

test("Ultra создаёт один артефакт и завершает его через scoped MCP", async (context) => {
  const fixture = await createRepository(context);
  const { command } = createCommand(fixture);
  const created = [];
  const prompts = [];
  const labels = [];
  const toolResults = [];
  const completedPlans = [];
  let completionAttempts = 0;
  let drainCalls = 0;
  let toolFlow;
  const service = createChangeArtifactCreationService({
    command,
    async createAgent(options) {
      created.push(options);
      const [{ url }] = Object.values(options.config.mcpServers);
      return {
        id: "agent-risk-map",
        async commands() {
          return {
            commands: [{ name: "openspec-continue-change", kind: "skill" }],
            error: null,
          };
        },
        async send(prompt) {
          prompts.push(prompt);
          toolFlow = (async () => {
            const client = await connectClient(url);
            try {
              const tools = await client.listTools();
              assert.deepEqual(tools.tools.map(({ name }) => name), [
                "complete_artifact",
              ]);
              toolResults.push(
                await client.callTool({ name: "complete_artifact", arguments: {} }),
              );
              assert.equal(drainCalls, 0);
              assert.deepEqual(labels, []);

              await writeFile(fixture.riskPath, "# Карта рисков\n");
              toolResults.push(
                await client.callTool({ name: "complete_artifact", arguments: {} }),
              );

              await execFileAsync("git", ["add", "openspec/changes/custom-change/risk-map.md"], {
                cwd: fixture.workspace,
              });
              await execFileAsync(
                "git",
                ["commit", "-m", "docs(openspec): add risk-map artifact"],
                { cwd: fixture.workspace },
              );
              toolResults.push(
                ...(await Promise.all([
                  client.callTool({ name: "complete_artifact", arguments: {} }),
                  client.callTool({ name: "complete_artifact", arguments: {} }),
                ])),
              );
              toolResults.push(
                await client.callTool({ name: "complete_artifact", arguments: {} }),
              );
            } finally {
              await client.close();
            }
          })();
        },
        async waitForFinish() {
          drainCalls += 1;
          await toolFlow;
          return { status: "idle", lastMessage: null };
        },
      };
    },
    async updateNotificationLabel(agentId, enabled) {
      labels.push([agentId, enabled]);
    },
    logger: { error() {}, warn() {} },
  });

  const session = await service.prepare(fixture.workspace, "custom-change");
  const plan = await service.create({
    workspaceDirectory: fixture.workspace,
    changeId: "custom-change",
    profile: ultraProfile(),
    session,
    signal: new AbortController().signal,
    onAgentCreated: () => undefined,
    async onArtifactCompleted(completedPlan) {
      completionAttempts += 1;
      if (completionAttempts === 1) throw new Error("checkpoint недоступен");
      completedPlans.push(completedPlan);
    },
  });

  assert.deepEqual(plan, { kind: "complete", schemaName: "custom-assurance" });
  assert.equal(created.length, 1);
  assert.equal(created[0].config.provider, "codex/gpt-6-astra");
  assert.equal(created[0].config.modeId, "default");
  assert.equal(created[0].config.thinkingOptionId, "ultra");
  assert.deepEqual(created[0].config.featureValues, { web: false });
  assert.deepEqual(created[0].labels, { ntfy: "true" });
  assert.equal("autoArchive" in created[0], false);
  assert.equal("cwd" in created[0], false);
  assert.equal("prompt" in created[0], false);
  assert.match(prompts[0], /openspec-continue-change.*exactly once/);
  assert.match(prompts[0], /expected artifact is `risk-map`/);
  assert.match(prompts[0], /explicitly approve/);
  assert.match(prompts[0], /never spawn or archive agents/);
  assert.match(prompts[0], /complete_artifact/);
  assert.equal(toolResults[0].isError, true);
  assert.match(firstText(toolResults[0]), /ещё не создан/);
  assert.equal(toolResults[1].isError, true);
  assert.match(firstText(toolResults[1]), /Рабочее дерево Git содержит/);
  assert.equal(toolResults.slice(2).filter(({ isError }) => isError === true).length, 1);
  assert.equal(toolResults.slice(2).filter(({ isError }) => isError !== true).length, 2);
  assert.equal(completionAttempts, 2);
  assert.equal(drainCalls, 1);
  assert.deepEqual(completedPlans, [
    { kind: "complete", schemaName: "custom-assurance" },
  ]);
  assert.deepEqual(labels, [
    ["agent-risk-map", false],
    ["agent-risk-map", true],
    ["agent-risk-map", false],
  ]);
});

test("отсутствие continue skill останавливает сессию до отправки задания", async (context) => {
  const fixture = await createRepository(context);
  const { command } = createCommand(fixture);
  const labels = [];
  let sends = 0;
  const service = createChangeArtifactCreationService({
    command,
    async createAgent() {
      return {
        id: "agent-without-skill",
        async commands() {
          return { commands: [], error: "provider не вернул catalog" };
        },
        async send() {
          sends += 1;
        },
        async waitForFinish() {
          return { status: "idle" };
        },
      };
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });
  const session = await service.prepare(fixture.workspace, "custom-change");

  await assert.rejects(
    service.create({
      workspaceDirectory: fixture.workspace,
      changeId: "custom-change",
      profile: ultraProfile(),
      session,
      signal: new AbortController().signal,
      onAgentCreated() {},
      async onArtifactCompleted() {},
    }),
    /не загрузил обязательный skill/,
  );
  assert.equal(sends, 0);
  assert.deepEqual(labels, [["agent-without-skill", false]]);
  assert.equal(await fileExists(fixture.riskPath), false);
});

test("после рестарта с готовым коммитом агент продолжает тот же артефакт без skill", async (context) => {
  const fixture = await createRepository(context);
  const { command } = createCommand(fixture);
  let prompt;
  let toolFlow;
  const service = createChangeArtifactCreationService({
    command,
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      return {
        id: "agent-recovered-risk-map",
        async commands() {
          return {
            commands: [{ name: "openspec-continue-change", kind: "skill" }],
            error: null,
          };
        },
        async send(value) {
          prompt = value;
          toolFlow = (async () => {
            const client = await connectClient(url);
            try {
              const result = await client.callTool({
                name: "complete_artifact",
                arguments: {},
              });
              assert.equal(result.isError, undefined);
            } finally {
              await client.close();
            }
          })();
        },
        async waitForFinish() {
          await toolFlow;
          return { status: "idle" };
        },
      };
    },
    updateNotificationLabel: async () => undefined,
    logger: { error() {}, warn() {} },
  });
  const session = await service.prepare(fixture.workspace, "custom-change");
  await writeFile(fixture.riskPath, "# Карта рисков\n");
  await execFileAsync("git", ["add", "openspec/changes/custom-change/risk-map.md"], {
    cwd: fixture.workspace,
  });
  await execFileAsync(
    "git",
    ["commit", "-m", "docs(openspec): add risk-map artifact"],
    { cwd: fixture.workspace },
  );

  await service.create({
    workspaceDirectory: fixture.workspace,
    changeId: "custom-change",
    profile: ultraProfile(),
    session,
    signal: new AbortController().signal,
    onAgentCreated() {},
    async onArtifactCompleted() {},
  });

  assert.match(prompt, /This is a recovery session/);
  assert.match(prompt, /Do not invoke the continue skill again/);
});

async function runRejectedCommitScenario(context, kind) {
  const fixture = await createRepository(context);
  const { command } = createCommand(fixture);
  const controller = new AbortController();
  let toolResult;
  let toolFlow;
  const service = createChangeArtifactCreationService({
    command,
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      return {
        id: `agent-${kind}`,
        async commands() {
          return {
            commands: [{ name: "openspec-continue-change", kind: "skill" }],
            error: null,
          };
        },
        async send() {
          toolFlow = (async () => {
            await writeFile(fixture.riskPath, "# Карта рисков\n");
            const unrelatedPath = join(fixture.workspace, "unrelated.txt");
            if (kind === "unrelated") await writeFile(unrelatedPath, "лишнее\n");
            await execFileAsync("git", ["add", "."], { cwd: fixture.workspace });
            await execFileAsync(
              "git",
              [
                "commit",
                "-m",
                kind === "wrong-subject"
                  ? "docs(openspec): add wrong artifact"
                  : "docs(openspec): add risk-map artifact",
              ],
              { cwd: fixture.workspace },
            );
            if (kind === "multiple") {
              await writeFile(unrelatedPath, "второй коммит\n");
              await execFileAsync("git", ["add", "unrelated.txt"], {
                cwd: fixture.workspace,
              });
              await execFileAsync("git", ["commit", "-m", "docs: add unrelated file"], {
                cwd: fixture.workspace,
              });
            }
            const client = await connectClient(url);
            try {
              toolResult = await client.callTool({
                name: "complete_artifact",
                arguments: {},
              });
            } finally {
              await client.close();
              controller.abort();
            }
          })();
        },
        async waitForFinish() {
          await toolFlow;
          return { status: "idle" };
        },
      };
    },
    updateNotificationLabel: async () => undefined,
    logger: { error() {}, warn() {} },
  });
  const session = await service.prepare(fixture.workspace, "custom-change");
  await assert.rejects(
    service.create({
      workspaceDirectory: fixture.workspace,
      changeId: "custom-change",
      profile: ultraProfile(),
      session,
      signal: controller.signal,
      onAgentCreated() {},
      async onArtifactCompleted() {},
    }),
    /отменена/,
  );
  return toolResult;
}

test("complete_artifact отклоняет посторонний файл в единственном коммите", async (context) => {
  const result = await runRejectedCommitScenario(context, "unrelated");
  assert.equal(result.isError, true);
  assert.match(firstText(result), /только файлы ожидаемого/);
});

test("complete_artifact отклоняет несколько коммитов после baseline", async (context) => {
  const result = await runRejectedCommitScenario(context, "multiple");
  assert.equal(result.isError, true);
  assert.match(firstText(result), /ровно один отдельный Git-коммит/);
});

test("complete_artifact проверяет subject отдельного коммита", async (context) => {
  const result = await runRejectedCommitScenario(context, "wrong-subject");
  assert.equal(result.isError, true);
  assert.match(firstText(result), /docs\(openspec\): add risk-map artifact/);
});
