import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inspectPublicationTarget, publishPublication } from "../server/change-publication-gateway.ts";
import { changePublicationPrompt } from "../server/change-publication.ts";

const changeId = "selected-change";
const branch = `change/${changeId}`;
const head = "a".repeat(40);
const mainHead = "b".repeat(40);
const title = "Добавить публикацию change";
const body = `## Суть\n\nОдин pull request для change.\n\n## Ожидаемый результат\n\nРабота завершается после проверки.\n\n## Границы change\n\nТолько выбранный change.\n\n## OpenSpec change\n\n\`${changeId}\``;
const url = "https://github.com/example/project/pull/41";

function fixture(options = {}) {
  let request = {
    number: 41, url, state: options.state ?? "OPEN", isDraft: options.isDraft ?? true,
    isCrossRepository: false, baseRefName: "main", headRefName: branch,
    headRefOid: options.remoteHead ?? head, title: "Название пользователя",
    body: options.body ?? "Текст пользователя\n\n<!-- paseo-openspec-orchestrator:findings:start -->\nFinding F1\n<!-- paseo-openspec-orchestrator:findings:end -->",
  };
  const calls = [];
  let updateCount = 0;
  const command = async (executable, args, options = {}) => {
    const key = `${executable} ${args.join(" ")}`;
    calls.push(key);
    if (key === "git status --porcelain=v1 --untracked-files=all") return { stdout: "", stderr: "" };
    if (key === "git branch --show-current") return { stdout: `${branch}\n`, stderr: "" };
    if (key === "git rev-parse HEAD") return { stdout: `${head}\n`, stderr: "" };
    if (key === "git remote get-url origin") return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    if (key.includes("ls-remote") && key.endsWith("refs/heads/main")) {
      return { stdout: `${mainHead}\trefs/heads/main\n`, stderr: "" };
    }
    if (key.includes("ls-remote") && key.endsWith(`refs/heads/${branch}`)) {
      return { stdout: `${request.headRefOid}\trefs/heads/${branch}\n`, stderr: "" };
    }
    if (key.startsWith("gh auth status ")) return { stdout: "", stderr: "" };
    if (key.startsWith("gh repo view ")) {
      return { stdout: JSON.stringify({ nameWithOwner: "example/project", url: "https://github.com/example/project" }), stderr: "" };
    }
    if (key.startsWith("gh pr list ")) {
      const listed = key.includes("--state all") ? request : {
        number: request.number, url: request.url, isDraft: request.isDraft,
        isCrossRepository: request.isCrossRepository, headRefName: request.headRefName,
      };
      return { stdout: JSON.stringify([listed]), stderr: "" };
    }
    if (key.startsWith("gh pr view ")) return { stdout: JSON.stringify(request), stderr: "" };
    if (key.startsWith("gh api ")) {
      updateCount += 1;
      const inputPath = args[args.indexOf("--input") + 1];
      const update = JSON.parse(await readFile(inputPath, "utf8"));
      if (!options.ignoreUpdate) request = { ...request, ...update };
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Неожиданная команда: ${key}`);
  };
  return { command, calls, get request() { return request; }, get updateCount() { return updateCount; } };
}

test("публикация обновляет управляемую секцию одного Draft PR, сохраняя текст и findings", async () => {
  const state = fixture();
  const target = await inspectPublicationTarget(state.command, process.cwd(), branch, branch, new AbortController().signal);
  const first = await publishPublication(state.command, {
    workspaceDirectory: process.cwd(), changeId, changeBranch: branch, activeBranch: branch,
    target, input: { title, body }, signal: new AbortController().signal,
  });
  assert.equal(first.number, 41);
  assert.equal(state.request.title, title);
  assert.match(state.request.body, /Текст пользователя/u);
  assert.match(state.request.body, /Finding F1/u);
  assert.match(state.request.body, /Один pull request для change/u);
  assert.equal(state.updateCount, 1);
  const targetAgain = await inspectPublicationTarget(state.command, process.cwd(), branch, branch, new AbortController().signal);
  await publishPublication(state.command, {
    workspaceDirectory: process.cwd(), changeId, changeBranch: branch, activeBranch: branch,
    target: targetAgain, input: { title, body }, signal: new AbortController().signal,
  });
  assert.equal(state.updateCount, 1);
  assert.equal(state.calls.some((call) => call.includes("pr create") || call.startsWith("git push")), false);
});

test("публикация останавливается при Ready, merged или расхождении origin", async () => {
  for (const options of [{ isDraft: false }, { state: "MERGED" }, { remoteHead: "c".repeat(40) }]) {
    const state = fixture(options);
    const target = await inspectPublicationTarget(state.command, process.cwd(), branch, branch, new AbortController().signal);
    await assert.rejects(publishPublication(state.command, {
      workspaceDirectory: process.cwd(), changeId, changeBranch: branch, activeBranch: branch,
      target, input: { title, body }, signal: new AbortController().signal,
    }));
    assert.equal(state.updateCount, 0);
  }
});

test("prompt публикации оставляет push и изменение PR оркестратору", () => {
  const prompt = changePublicationPrompt({
    changeId, changeBranch: branch, activeBranch: branch,
    target: {
      repository: "example/project", repositoryIdentity: { host: "github.com", nameWithOwner: "example/project" },
      repositoryUrl: "https://github.com/example/project", expectedHead: head,
      expectedChangeHead: head,
      existingPullRequest: { number: 41, url, isDraft: true, isCrossRepository: false, headRefName: branch },
    },
  });
  assert.match(prompt, /Do not push/u);
  assert.match(prompt, /Never invoke `gh`/u);
});
