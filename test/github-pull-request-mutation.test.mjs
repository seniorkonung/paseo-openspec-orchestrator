import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  updateGitHubPullRequest,
} from "../server/github-pull-request-mutation.ts";

const workspaceDirectory = process.cwd();

test("единый шлюз изменяет поля PR через REST и удаляет приватный JSON", async () => {
  let requestPath;
  let request;
  let invocation;
  await updateGitHubPullRequest(
    async (executable, arguments_, options) => {
      requestPath = arguments_[arguments_.indexOf("--input") + 1];
      request = JSON.parse(await readFile(requestPath, "utf8"));
      invocation = { executable, arguments: arguments_, options };
      return { stdout: "", stderr: "" };
    },
    workspaceDirectory,
    { host: "github.example.com", nameWithOwner: "example/project" },
    20,
    { title: "Новое название", body: "Новое описание", base: "main" },
  );

  assert.deepEqual(request, {
    title: "Новое название",
    body: "Новое описание",
    base: "main",
  });
  assert.deepEqual(invocation, {
    executable: "gh",
    arguments: [
      "api",
      "--method",
      "PATCH",
      "--hostname",
      "github.example.com",
      "-H",
      "Accept: application/vnd.github+json",
      "repos/example/project/pulls/20",
      "--input",
      requestPath,
      "--silent",
    ],
    options: { cwd: workspaceDirectory, signal: undefined },
  });
  await assert.rejects(access(requestPath));
});

test("единый шлюз удаляет JSON после ошибки GitHub API", async () => {
  let requestPath;
  await assert.rejects(
    updateGitHubPullRequest(
      async (_executable, arguments_) => {
        requestPath = arguments_[arguments_.indexOf("--input") + 1];
        throw new Error("GitHub API failed");
      },
      workspaceDirectory,
      { host: "github.com", nameWithOwner: "example/project" },
      20,
      { body: "Описание" },
    ),
    /Не удалось обновить pull request #20/,
  );
  await assert.rejects(access(requestPath));
});

test("production-код не вызывает уязвимый gh pr edit напрямую", async () => {
  const serverDirectory = join(workspaceDirectory, "server");
  const paths = (await readdir(serverDirectory, { recursive: true }))
    .filter((path) => path.endsWith(".ts"));
  const violations = [];
  for (const path of paths) {
    const source = await readFile(join(serverDirectory, path), "utf8");
    if (/["']pr["']\s*,\s*["']edit["']/u.test(source)) {
      violations.push(path);
    }
  }
  assert.deepEqual(violations, []);

  const agentPrompt = await readFile(
    join(serverDirectory, "agent-prompt.ts"),
    "utf8",
  );
  assert.match(
    agentPrompt,
    /never use `gh pr edit`, because pull-request field mutations belong to the orchestrator/u,
  );
});
