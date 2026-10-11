import assert from "node:assert/strict";
import test from "node:test";
import { createRootPullRequestService } from "../server/root-pull-request.ts";

const changeId = "root-gate";
const changeBranch = `change/${changeId}`;
const head = "a".repeat(40);
const repositoryUrl = "https://github.com/example/project";

function commandFor(state, remoteHead = null) {
  const pullRequest = {
    number: 41,
    url: `${repositoryUrl}/pull/41`,
    state,
    isDraft: state === "OPEN",
    isCrossRepository: false,
    baseRefName: "main",
    headRefName: changeBranch,
    headRefOid: head,
    mergeCommit: state === "MERGED" ? { oid: head } : null,
    title: "Корневой PR",
    body: "Описание",
  };
  return async (executable, arguments_) => {
    const key = `${executable} ${arguments_.join(" ")}`;
    if (key === "git status --porcelain=v1 --untracked-files=all") return { stdout: "", stderr: "" };
    if (key === "git branch --show-current") return { stdout: `${changeBranch}\n`, stderr: "" };
    if (key === "git rev-parse HEAD") return { stdout: `${head}\n`, stderr: "" };
    if (key.startsWith("git for-each-ref ")) {
      return { stdout: `${head}\0refs/heads/${changeBranch}\n`, stderr: "" };
    }
    if (key.startsWith("git ls-remote --heads origin ")) {
      return { stdout: remoteHead === null ? "" : `${remoteHead}\trefs/heads/${changeBranch}\n`, stderr: "" };
    }
    if (key === "git remote get-url origin") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (key.startsWith("gh auth status ")) return { stdout: "", stderr: "" };
    if (key.startsWith("gh repo view ")) {
      return { stdout: JSON.stringify({ nameWithOwner: "example/project", url: repositoryUrl }), stderr: "" };
    }
    if (key.startsWith("gh pr list ")) return { stdout: JSON.stringify([pullRequest]), stderr: "" };
    if (key.startsWith("gh pr view ")) return { stdout: JSON.stringify(pullRequest), stderr: "" };
    throw new Error(`Неожиданная команда: ${key}`);
  };
}

test("финальный gate принимает merged root PR с точным local head после удаления remote branch", async () => {
  const service = createRootPullRequestService({ command: commandFor("MERGED") });
  assert.equal(await service.synchronize("/repo", changeId, changeBranch), head);
  const inspection = await service.inspect("/repo", changeId, changeBranch, null);
  assert.equal(inspection.kind, "merged");
  assert.equal(inspection.head, head);
  assert.equal(inspection.identity.number, 41);
});

test("открытый root PR без remote head отклоняется", async () => {
  const service = createRootPullRequestService({ command: commandFor("OPEN") });
  await assert.rejects(
    service.inspect("/repo", changeId, changeBranch, null),
    /неверные repository, base, head или commit/u,
  );
});

test("постороннее продвижение root branch останавливает workflow без fast-forward", async () => {
  const remoteHead = "b".repeat(40);
  const service = createRootPullRequestService({ command: commandFor("OPEN", remoteHead) });
  await assert.rejects(
    service.synchronize("/repo", changeId, changeBranch),
    /расходится с origin/u,
  );
});

function checksResponse({ state = "OPEN", headRefName = changeBranch, commitOid = head, rollup = null } = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          number: 41,
          state,
          isDraft: false,
          isCrossRepository: false,
          baseRefName: "main",
          headRefName,
          headRefOid: head,
          commits: { nodes: [{ commit: { oid: commitOid, statusCheckRollup: rollup } }] },
        },
      },
    },
  };
}

const rootIdentity = {
  number: 41,
  url: `${repositoryUrl}/pull/41`,
  repositoryHost: "github.com",
  repositoryNameWithOwner: "example/project",
  repositoryUrl,
  changeBranch,
};

function checksCommand(response, calls = []) {
  return async (executable, arguments_) => {
    calls.push([executable, ...arguments_]);
    return { stdout: JSON.stringify(response), stderr: "" };
  };
}

test("проверки CI корневого PR считаются по завершённости без оценки их исхода", async () => {
  const calls = [];
  const rollup = {
    contexts: {
      checkRunCountsByState: [
        { state: "SUCCESS", count: 2 },
        { state: "FAILURE", count: 1 },
        { state: "CANCELLED", count: 1 },
        { state: "IN_PROGRESS", count: 1 },
        { state: "QUEUED", count: 2 },
        { state: "WAITING", count: 1 },
      ],
      statusContextCountsByState: [
        { state: "ERROR", count: 1 },
        { state: "PENDING", count: 1 },
        { state: "EXPECTED", count: 1 },
      ],
    },
  };
  const service = createRootPullRequestService({ command: checksCommand(checksResponse({ rollup }), calls) });

  assert.deepEqual(await service.inspectChecks("/repo", rootIdentity), {
    kind: "open",
    isDraft: false,
    head,
    checks: { total: 11, pending: 6 },
  });
  // Запрос читает только GitHub, а аргументы передаются без shell.
  assert.equal(calls.length, 1);
  const [executable, ...arguments_] = calls[0];
  assert.equal(executable, "gh");
  assert.deepEqual(arguments_.slice(0, 4), ["api", "graphql", "--hostname", "github.com"]);
  assert.ok(arguments_.includes("owner=example"));
  assert.ok(arguments_.includes("name=project"));
  assert.ok(arguments_.includes("number=41"));
});

test("коммит без проверок CI не содержит незавершённых проверок", async () => {
  const service = createRootPullRequestService({ command: checksCommand(checksResponse()) });
  const inspection = await service.inspectChecks("/repo", rootIdentity);
  assert.deepEqual(inspection.checks, { total: 0, pending: 0 });
});

test("проверки CI слитого PR не читаются, а неверный или устаревший head отклоняется", async () => {
  const merged = createRootPullRequestService({ command: checksCommand(checksResponse({ state: "MERGED" })) });
  assert.deepEqual(await merged.inspectChecks("/repo", rootIdentity), { kind: "merged", head });

  const foreign = createRootPullRequestService({ command: checksCommand(checksResponse({ headRefName: "change/other" })) });
  await assert.rejects(foreign.inspectChecks("/repo", rootIdentity), /неверные repository, base или head/u);

  const stale = createRootPullRequestService({ command: checksCommand(checksResponse({ commitOid: "b".repeat(40) })) });
  await assert.rejects(stale.inspectChecks("/repo", rootIdentity), /ещё не обновил проверки HEAD/u);
});

test("неизвестное состояние проверки и сбой gh останавливают чтение проверок CI", async () => {
  const unknown = createRootPullRequestService({
    command: checksCommand(checksResponse({
      rollup: { contexts: { checkRunCountsByState: [{ state: "UNKNOWN", count: 1 }], statusContextCountsByState: [] } },
    })),
  });
  await assert.rejects(unknown.inspectChecks("/repo", rootIdentity), /Не удалось прочитать проверки CI корневого pull request #41/u);

  const offline = createRootPullRequestService({ command: async () => { throw new Error("gh: network"); } });
  await assert.rejects(offline.inspectChecks("/repo", rootIdentity), /Не удалось прочитать проверки CI корневого pull request #41/u);
});
