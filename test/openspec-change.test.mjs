import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createOpenSpecChangeVerifier,
  OpenSpecChangeError,
} from "../server/openspec-change.ts";
import { createAgentNotificationLabelUpdater } from "../server/paseo-agent-labels.ts";

async function workspaceFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "openspec-change-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const changeRoot = join(root, "openspec", "changes", "selected-change");
  await mkdir(changeRoot, { recursive: true });
  return { root, changeRoot };
}

function status(changeRoot) {
  return JSON.stringify({
    changeName: "selected-change",
    changeRoot,
    actionContext: { mode: "repo-local", sourceOfTruth: "repo" },
  });
}

test("проверяет repo-local change, чистоту Git и присутствие в HEAD", async (context) => {
  const { root, changeRoot } = await workspaceFixture(context);
  const calls = [];
  const verifier = createOpenSpecChangeVerifier({
    async command(executable, arguments_, options) {
      calls.push({ executable, arguments_, cwd: options?.cwd });
      if (executable === "openspec") return { stdout: status(changeRoot), stderr: "" };
      if (arguments_[0] === "rev-parse") return { stdout: `${root}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(await verifier(root, "selected-change"), { id: "selected-change" });
  assert.deepEqual(
    calls.map(({ executable, arguments_ }) => [executable, ...arguments_]),
    [
      ["openspec", "status", "--change", "selected-change", "--json"],
      ["git", "rev-parse", "--show-toplevel"],
      ["git", "cat-file", "-e", "HEAD:openspec/changes/selected-change"],
      ["git", "status", "--porcelain=v1", "--untracked-files=all"],
    ],
  );
});

test("отклоняет change вне workspace, грязное дерево и отсутствие в HEAD", async (context) => {
  const { root, changeRoot } = await workspaceFixture(context);
  const outside = await mkdtemp(join(tmpdir(), "openspec-change-outside-"));
  context.after(() => rm(outside, { recursive: true, force: true }));

  const outsideVerifier = createOpenSpecChangeVerifier({
    command: async (executable) =>
      executable === "openspec"
        ? { stdout: status(outside), stderr: "" }
        : { stdout: `${root}\n`, stderr: "" },
  });
  await assert.rejects(
    outsideVerifier(root, "selected-change"),
    /за пределами текущего workspace/,
  );

  const dirtyVerifier = createOpenSpecChangeVerifier({
    async command(executable, arguments_) {
      if (executable === "openspec") return { stdout: status(changeRoot), stderr: "" };
      if (arguments_[0] === "rev-parse") return { stdout: `${root}\n`, stderr: "" };
      if (arguments_[0] === "cat-file") return { stdout: "", stderr: "" };
      if (arguments_[0] === "status") return { stdout: "?? new-file\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });
  await assert.rejects(dirtyVerifier(root, "selected-change"), /незакоммиченные/);

  const uncommittedVerifier = createOpenSpecChangeVerifier({
    async command(executable, arguments_) {
      if (executable === "openspec") return { stdout: status(changeRoot), stderr: "" };
      if (arguments_[0] === "rev-parse") return { stdout: `${root}\n`, stderr: "" };
      if (arguments_[0] === "cat-file") throw new Error("missing from HEAD");
      return { stdout: "", stderr: "" };
    },
  });
  await assert.rejects(uncommittedVerifier(root, "selected-change"), /последний Git-коммит/);
});

test("возвращает безопасные ошибки для отсутствующего change и неверного ID", async () => {
  const verifier = createOpenSpecChangeVerifier({
    command: async () => {
      throw new Error("секретная внутренняя ошибка");
    },
  });

  await assert.rejects(
    verifier("/workspace", "missing-change"),
    (error) =>
      error instanceof OpenSpecChangeError &&
      /не подтвердил существование/.test(error.message) &&
      !/секретная/.test(error.message),
  );
  await assert.rejects(verifier("/workspace", "../escape"), /kebab-case/);
});

test("обновляет ntfy через paseo CLI без shell-интерполяции", async () => {
  const calls = [];
  const update = createAgentNotificationLabelUpdater(
    async (executable, arguments_, options) => {
      calls.push({ executable, arguments_, options });
      return { stdout: "{}", stderr: "" };
    },
  );

  await update("agent-123", false);

  assert.deepEqual(calls[0].executable, "paseo");
  assert.deepEqual(calls[0].arguments_, [
    "agent",
    "update",
    "agent-123",
    "--label",
    "ntfy=false",
    "--json",
  ]);
});
