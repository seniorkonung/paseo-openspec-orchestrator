import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  changePublicationPrompt,
  createChangePublicationService,
} from "../server/change-publication.ts";

const changeId = "selected-change";
const changeBranch = `change/${changeId}`;
const activeBranch = `planning/${changeId}/initial`;
const head = "a".repeat(40);
const changeHead = "c".repeat(40);
const mainHead = "b".repeat(40);
const repository = "example/project";
const repositoryUrl = "https://github.com/example/project";
const originUrl = "git@github.com:example/project.git";
const workspaceDirectory = process.cwd();
const title = "Добавить публикацию интеграционного pull request";
const body = `## Суть

Change получает единый интеграционный pull request.

## Ожидаемый результат

Ветка и описание публикуются согласованно.

## Границы change

Только публикация выбранного change.

## OpenSpec change

\`${changeId}\``;

function profile() {
  return {
    id: "profile-medium-sandbox",
    name: "Medium Sandbox",
    provider: "codex",
    model: "gpt-5.5",
    modeId: "sandbox",
    thinkingOptionId: "medium",
    featureValues: { fast: true },
  };
}

function pullRequest(overrides = {}) {
  return {
    number: 42,
    url: `${repositoryUrl}/pull/42`,
    state: "OPEN",
    isDraft: true,
    isCrossRepository: false,
    baseRefName: "main",
    headRefName: changeBranch,
    headRefOid: changeHead,
    title,
    body,
    ...overrides,
  };
}

function openPullRequest(value) {
  return {
    number: value.number,
    url: value.url,
    isDraft: value.isDraft,
    isCrossRepository: value.isCrossRepository,
    headRefName: value.headRefName,
  };
}

async function connectClient(url) {
  const client = new Client({ name: "change-publication-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

function startPublicationAttempt(command, completionArguments = { title, body }) {
  const controller = new AbortController();
  let startTool;
  const toolStarted = new Promise((resolve) => {
    startTool = resolve;
  });
  let toolFlow;
  const service = createChangePublicationService({
    command,
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      toolFlow = (async () => {
        const client = await connectClient(url);
        try {
          return await client.callTool({
            name: "complete_change_publication",
            arguments: completionArguments,
          });
        } finally {
          await client.close();
        }
      })();
      startTool();
      return {
        id: "agent-verification",
        waitForFinish: async () => {
          await toolFlow;
          return { status: "idle" };
        },
      };
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });
  const publication = service.publish({
    workspaceDirectory,
    changeId,
    changeBranch,
    activeBranch,
    profile: profile(),
    signal: controller.signal,
    onAgentCreated() {},
  });
  return {
    publication,
    async toolResult() {
      await toolStarted;
      return toolFlow;
    },
    async cancel() {
      controller.abort();
      await assert.rejects(publication, { name: "AbortError" });
    },
  };
}

function firstText(result) {
  const content = result.content[0];
  assert.equal(content?.type, "text");
  return content.text;
}

function publicationCommand({
  existing = pullRequest(),
  verified = pullRequest({ title: "Старое название", body: "Старое описание" }),
  dirtyAtCompletion = false,
  dirtyInitially = false,
  remoteHead = head,
  remoteChangeHead = changeHead,
  localHeads = [head],
  ignoreUpdate = false,
  updateError = null,
} = {}) {
  let listCalls = 0;
  let statusCalls = 0;
  let headCalls = 0;
  let dirtyCompletionChecks = dirtyAtCompletion ? 1 : 0;
  let currentPullRequest = structuredClone(verified);
  let updateCount = 0;
  const calls = [];
  const command = async (executable, arguments_, options) => {
    calls.push({ executable, arguments: [...arguments_], options });
    const key = `${executable} ${arguments_.join(" ")}`;
    if (key === "git remote get-url origin") return { stdout: `${originUrl}\n`, stderr: "" };
    if (key === "gh auth status --hostname github.com") {
      return { stdout: "", stderr: "" };
    }
    if (key === `gh repo view ${repository} --json nameWithOwner,url`) {
      return {
        stdout: JSON.stringify({ nameWithOwner: repository, url: repositoryUrl }),
        stderr: "",
      };
    }
    if (
      key === "git ls-remote --exit-code --heads origin refs/heads/main"
    ) {
      return { stdout: `${mainHead}\trefs/heads/main\n`, stderr: "" };
    }
    if (key.startsWith("gh pr list ")) {
      listCalls += 1;
      const values = listCalls === 1 ? [existing] : [currentPullRequest];
      return { stdout: JSON.stringify(values.map(openPullRequest)), stderr: "" };
    }
    if (key === "git status --porcelain=v1 --untracked-files=all") {
      statusCalls += 1;
      const dirtyAfterAgent = statusCalls > 1 && dirtyCompletionChecks > 0;
      if (dirtyAfterAgent) dirtyCompletionChecks -= 1;
      return {
        stdout: dirtyInitially || dirtyAfterAgent ? "?? unexpected.txt\n" : "",
        stderr: "",
      };
    }
    if (key === "git branch --show-current") {
      return { stdout: `${activeBranch}\n`, stderr: "" };
    }
    if (key === "git rev-parse HEAD") {
      const value = localHeads[Math.min(headCalls, localHeads.length - 1)];
      headCalls += 1;
      return { stdout: `${value}\n`, stderr: "" };
    }
    if (key === `git ls-remote --exit-code --heads origin refs/heads/${activeBranch}`) {
      return { stdout: `${remoteHead}\trefs/heads/${activeBranch}\n`, stderr: "" };
    }
    if (key === `git ls-remote --exit-code --heads origin refs/heads/${changeBranch}`) {
      return {
        stdout: `${remoteChangeHead}\trefs/heads/${changeBranch}\n`,
        stderr: "",
      };
    }
    if (key === `gh pr view 42 --repo ${repository} --json number,url,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,title,body`) {
      return { stdout: JSON.stringify(currentPullRequest), stderr: "" };
    }
    if (executable === "gh" && arguments_[0] === "api") {
      updateCount += 1;
      if (updateError) throw updateError;
      const requestPath = arguments_[arguments_.indexOf("--input") + 1];
      const update = JSON.parse(await readFile(requestPath, "utf8"));
      if (!ignoreUpdate) {
        currentPullRequest = {
          ...currentPullRequest,
          ...update,
          ...(update.base === undefined ? {} : { baseRefName: update.base }),
        };
        delete currentPullRequest.base;
      }
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Неожиданная команда: ${key}`);
  };
  return {
    command,
    calls,
    get updateCount() { return updateCount; },
  };
}

test("Medium Sandbox актуализирует корневой Draft PR через scoped MCP", async () => {
  const created = [];
  const labels = [];
  const links = [];
  const toolResults = [];
  const fixture = publicationCommand();
  const { command, calls } = fixture;
  let toolFlow;
  const service = createChangePublicationService({
    command,
    async createAgent(options) {
      created.push(options);
      const [{ url }] = Object.values(options.config.mcpServers);
      toolFlow = (async () => {
        const client = await connectClient(url);
        try {
          const tools = await client.listTools();
          assert.deepEqual(tools.tools.map(({ name }) => name), [
            "complete_change_publication",
          ]);
          toolResults.push(
            await client.callTool({
              name: "complete_change_publication",
              arguments: { title, body },
            }),
          );
        } finally {
          await client.close();
        }
      })();
      return {
        id: "agent-publication",
        waitForFinish: async () => {
          await toolFlow;
          return { status: "idle", lastMessage: null };
        },
      };
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });

  const result = await service.publish({
    workspaceDirectory,
    changeId,
    changeBranch,
    activeBranch,
    profile: profile(),
    signal: new AbortController().signal,
    onAgentCreated: (agentId) => links.push(agentId),
  });

  assert.deepEqual(result, {
    number: 42,
    url: `${repositoryUrl}/pull/42`,
    title,
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].config.provider, "codex/gpt-5.5");
  assert.equal(created[0].config.modeId, "sandbox");
  assert.equal(created[0].config.thinkingOptionId, "medium");
  assert.deepEqual(created[0].config.featureValues, { fast: true });
  assert.deepEqual(created[0].labels, { ntfy: "true" });
  assert.equal("autoArchive" in created[0], false);
  assert.equal("cwd" in created[0], false);
  assert.match(created[0].prompt, /openspec status --change selected-change --json/);
  assert.match(created[0].prompt, /git push --set-upstream origin planning\/selected-change/);
  assert.match(created[0].prompt, /Never invoke `gh` or call GitHub APIs/);
  assert.match(created[0].prompt, /orchestrator owns pull-request mutation/);
  assert.match(created[0].prompt, /never spawn or archive agents/);
  assert.deepEqual(links, ["agent-publication"]);
  assert.deepEqual(labels, [["agent-publication", false]]);
  assert.equal(toolResults[0].isError, undefined);
  assert.deepEqual(toolResults[0].structuredContent, {
    pullRequestNumber: 42,
    url: `${repositoryUrl}/pull/42`,
    title,
  });
  assert.ok(
    calls.every(({ options }) => options.cwd === workspaceDirectory),
    "все команды должны выполняться из workspace",
  );
  assert.equal(fixture.updateCount, 1);
});

test("актуализирует существующий Ready PR и сохраняет его статус", async () => {
  const existing = pullRequest({ isDraft: false, baseRefName: "develop", title: "Старое", body: "Старое" });
  const verified = pullRequest({ isDraft: false, title: "Старое", body: "Старое" });
  const { command } = publicationCommand({ existing, verified });
  let toolFlow;
  const service = createChangePublicationService({
    command,
    async createAgent(options) {
      assert.match(options.prompt, /"existingOpenPullRequest":42/);
      const [{ url }] = Object.values(options.config.mcpServers);
      toolFlow = (async () => {
        const client = await connectClient(url);
        try {
          return await client.callTool({
            name: "complete_change_publication",
            arguments: { title, body },
          });
        } finally {
          await client.close();
        }
      })();
      return {
        id: "agent-existing-pr",
        waitForFinish: async () => {
          await toolFlow;
          return { status: "idle" };
        },
      };
    },
    updateNotificationLabel: async () => {},
    logger: { error() {}, warn() {} },
  });

  const result = await service.publish({
    workspaceDirectory,
    changeId,
    changeBranch,
    activeBranch,
    profile: profile(),
    signal: new AbortController().signal,
    onAgentCreated() {},
  });
  assert.equal(result.number, 42);
  assert.equal((await toolFlow).isError, undefined);
});

test("отклоняет несколько открытых PR до создания агента", async () => {
  let created = false;
  const first = pullRequest();
  const { command } = publicationCommand();
  const ambiguousCommand = async (executable, arguments_, options) => {
    if (executable === "gh" && arguments_[0] === "pr" && arguments_[1] === "list") {
      return {
        stdout: JSON.stringify([
          openPullRequest(first),
          openPullRequest({ ...first, number: 43 }),
        ]),
        stderr: "",
      };
    }
    return command(executable, arguments_, options);
  };
  const service = createChangePublicationService({
    command: ambiguousCommand,
    async createAgent() {
      created = true;
      throw new Error("не должен быть вызван");
    },
  });

  await assert.rejects(
    service.publish({
      workspaceDirectory,
      changeId,
      changeBranch,
      activeBranch,
      profile: profile(),
      signal: new AbortController().signal,
      onAgentCreated() {},
    }),
    /несколько открытых pull request/,
  );
  assert.equal(created, false);
});

test("отклоняет PR из fork до создания агента", async () => {
  let created = false;
  const { command } = publicationCommand({
    existing: pullRequest({ isCrossRepository: true }),
  });
  const service = createChangePublicationService({
    command,
    async createAgent() {
      created = true;
      throw new Error("не должен быть вызван");
    },
  });

  await assert.rejects(
    service.publish({
      workspaceDirectory,
      changeId,
      changeBranch,
      activeBranch,
      profile: profile(),
      signal: new AbortController().signal,
      onAgentCreated() {},
    }),
    /использует fork вместо origin/,
  );
  assert.equal(created, false);
});

test("останавливается до агента при грязном рабочем дереве", async () => {
  let created = false;
  const { command } = publicationCommand({ dirtyInitially: true });
  const service = createChangePublicationService({
    command,
    async createAgent() {
      created = true;
      throw new Error("не должен быть вызван");
    },
  });

  await assert.rejects(
    service.publish({
      workspaceDirectory,
      changeId,
      changeBranch,
      activeBranch,
      profile: profile(),
      signal: new AbortController().signal,
      onAgentCreated() {},
    }),
    /незакоммиченные или неотслеживаемые/,
  );
  assert.equal(created, false);
});

test("возвращает feedback для грязного дерева и принимает повторный MCP-вызов", async () => {
  const { command } = publicationCommand({ dirtyAtCompletion: true });
  const toolResults = [];
  const labels = [];
  let toolFlow;
  const service = createChangePublicationService({
    command,
    async createAgent(options) {
      const [{ url }] = Object.values(options.config.mcpServers);
      toolFlow = (async () => {
        const client = await connectClient(url);
        try {
          toolResults.push(
            await client.callTool({
              name: "complete_change_publication",
              arguments: { title, body },
            }),
          );
          toolResults.push(
            await client.callTool({
              name: "complete_change_publication",
              arguments: { title, body },
            }),
          );
        } finally {
          await client.close();
        }
      })();
      return {
        id: "agent-dirty",
        waitForFinish: async () => {
          await toolFlow;
          return { status: "idle" };
        },
      };
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });

  const publication = await service.publish({
    workspaceDirectory,
    changeId,
    changeBranch,
    activeBranch,
    profile: profile(),
    signal: new AbortController().signal,
    onAgentCreated() {},
  });

  assert.equal(publication.number, 42);
  assert.equal(toolResults[0].isError, true);
  assert.match(firstText(toolResults[0]), /незакоммиченные или неотслеживаемые/);
  assert.equal(toolResults[1].isError, undefined);
  assert.deepEqual(labels, [["agent-dirty", false]]);
});

test("не подтверждает публикацию, если агент изменил локальный HEAD", async () => {
  const changedHead = "c".repeat(40);
  const { command } = publicationCommand({
    localHeads: [head, changedHead],
    remoteHead: changedHead,
    verified: pullRequest({ headRefOid: changedHead }),
  });
  const attempt = startPublicationAttempt(command);

  const toolResult = await attempt.toolResult();
  assert.equal(toolResult.isError, true);
  assert.match(firstText(toolResult), /HEAD изменился/);
  await attempt.cancel();
});

test("не подтверждает публикацию при несовпадении remote SHA", async () => {
  const { command } = publicationCommand({ remoteHead: "c".repeat(40) });
  const attempt = startPublicationAttempt(command);

  const toolResult = await attempt.toolResult();
  assert.equal(toolResult.isError, true);
  assert.match(firstText(toolResult), /origin не содержит текущий HEAD/);
  await attempt.cancel();
});

test("не подтверждает PR с отличающейся base-веткой", async () => {
  const { command } = publicationCommand({
    verified: pullRequest({ baseRefName: "develop" }),
  });
  const attempt = startPublicationAttempt(command);

  const toolResult = await attempt.toolResult();
  assert.equal(toolResult.isError, true);
  assert.match(firstText(toolResult), /направлен в ветку main/);
  await attempt.cancel();
});

test("не подтверждает название и описание, если GitHub не сохранил обновление", async () => {
  const { command } = publicationCommand({
    verified: pullRequest({ body: `${body}\nЛишний текст` }),
    ignoreUpdate: true,
  });
  const attempt = startPublicationAttempt(command);

  const toolResult = await attempt.toolResult();
  assert.equal(toolResult.isError, true);
  assert.match(firstText(toolResult), /не подтвердил обновлённые название и описание/);
  await attempt.cancel();
});

test("останавливается до агента, если gh не авторизован для origin", async () => {
  let created = false;
  const { command } = publicationCommand();
  const unauthorizedCommand = async (executable, arguments_, options) => {
    if (executable === "gh" && arguments_[0] === "auth") {
      throw Object.assign(new Error("not logged in"), { stderr: "secret output" });
    }
    return command(executable, arguments_, options);
  };
  const service = createChangePublicationService({
    command: unauthorizedCommand,
    async createAgent() {
      created = true;
      throw new Error("не должен быть вызван");
    },
  });

  await assert.rejects(
    service.publish({
      workspaceDirectory,
      changeId,
      changeBranch,
      activeBranch,
      profile: profile(),
      signal: new AbortController().signal,
      onAgentCreated() {},
    }),
    /GitHub CLI недоступен или не авторизован/,
  );
  assert.equal(created, false);
});

test("останавливается до агента, если origin отсутствует", async () => {
  let created = false;
  const service = createChangePublicationService({
    async command(executable, arguments_) {
      const key = `${executable} ${arguments_.join(" ")}`;
      if (key === "git status --porcelain=v1 --untracked-files=all") {
        return { stdout: "", stderr: "" };
      }
      if (key === "git branch --show-current") {
        return { stdout: `${activeBranch}\n`, stderr: "" };
      }
      if (key === "git rev-parse HEAD") {
        return { stdout: `${head}\n`, stderr: "" };
      }
      if (key === "git remote get-url origin") {
        throw new Error("No such remote");
      }
      throw new Error(`Неожиданная команда: ${key}`);
    },
    async createAgent() {
      created = true;
      throw new Error("не должен быть вызван");
    },
  });

  await assert.rejects(
    service.publish({
      workspaceDirectory,
      changeId,
      changeBranch,
      activeBranch,
      profile: profile(),
      signal: new AbortController().signal,
      onAgentCreated() {},
    }),
    /remote origin отсутствует/,
  );
  assert.equal(created, false);
});

test("окончание хода без completion сохраняет ntfy и MCP scope", async () => {
  const { command } = publicationCommand();
  const labels = [];
  let createdOptions;
  let resolveAgentCreated;
  const agentCreated = new Promise((resolve) => {
    resolveAgentCreated = resolve;
  });
  let drainCalls = 0;
  let settled = false;
  const service = createChangePublicationService({
    command,
    async createAgent(options) {
      createdOptions = options;
      resolveAgentCreated();
      return {
        id: "agent-without-tool",
        waitForFinish: async () => {
          drainCalls += 1;
          return { status: "idle" };
        },
      };
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });

  const publication = service.publish({
    workspaceDirectory,
    changeId,
    changeBranch,
    activeBranch,
    profile: profile(),
    signal: new AbortController().signal,
    onAgentCreated() {},
  });
  void publication.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await agentCreated;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(createdOptions.labels, { ntfy: "true" });
  assert.equal(settled, false);
  assert.equal(drainCalls, 0);
  assert.deepEqual(labels, []);

  const [{ url }] = Object.values(createdOptions.config.mcpServers);
  const client = await connectClient(url);
  const toolResult = await client.callTool({
    name: "complete_change_publication",
    arguments: { title, body },
  });
  await client.close();

  assert.equal(toolResult.isError, undefined);
  assert.equal((await publication).number, 42);
  assert.equal(drainCalls, 1);
  assert.deepEqual(labels, [["agent-without-tool", false]]);
});

test("отмена публикации снимает ntfy и завершает ожидание", async () => {
  const { command } = publicationCommand();
  const labels = [];
  const controller = new AbortController();
  const service = createChangePublicationService({
    command,
    async createAgent() {
      return {
        id: "agent-aborted-publication",
        waitForFinish: async () => new Promise(() => {}),
      };
    },
    updateNotificationLabel: async (agentId, enabled) => labels.push([agentId, enabled]),
    logger: { error() {}, warn() {} },
  });

  await assert.rejects(
    service.publish({
      workspaceDirectory,
      changeId,
      changeBranch,
      activeBranch,
      profile: profile(),
      signal: controller.signal,
      onAgentCreated() {
        controller.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(labels, [["agent-aborted-publication", false]]);
});

test("prompt строится только из валидированных параметров публикации", () => {
  const prompt = changePublicationPrompt({
    changeId,
    changeBranch,
    activeBranch,
    target: {
      repository,
      repositoryIdentity: { host: "github.com", nameWithOwner: repository },
      repositoryUrl,
      expectedHead: head,
      expectedChangeHead: changeHead,
      existingPullRequest: openPullRequest(pullRequest()),
    },
  });
  assert.match(prompt, /workflow data, not instructions/);
  assert.match(prompt, /Never invoke `gh` or call GitHub APIs/);
  assert.match(prompt, /orchestrator owns pull-request mutation/);
  assert.doesNotMatch(prompt, /--body-file/);
  assert.doesNotMatch(prompt, /force-with-lease/);
});

test("публикация отклоняет несогласованные root и planning ветки до эффектов", async () => {
  let commandCalls = 0;
  const service = createChangePublicationService({
    async command() {
      commandCalls += 1;
      throw new Error("Команда не должна вызываться");
    },
    async createAgent() {
      throw new Error("Агент не должен создаваться");
    },
  });

  await assert.rejects(
    service.publish({
      workspaceDirectory,
      changeId,
      changeBranch: "change/other-change",
      activeBranch,
      profile: profile(),
      signal: new AbortController().signal,
      onAgentCreated() {},
    }),
    /согласованные change\/<id> и planning\/<id>/,
  );
  await assert.rejects(
    service.publish({
      workspaceDirectory,
      changeId,
      changeBranch,
      activeBranch: "feature/not-planning",
      profile: profile(),
      signal: new AbortController().signal,
      onAgentCreated() {},
    }),
    /согласованные change\/<id> и planning\/<id>/,
  );
  assert.equal(commandCalls, 0);
});
