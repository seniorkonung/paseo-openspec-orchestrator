import assert from "node:assert/strict";
import test from "node:test";
import { createImplementationPullRequestService } from "../server/implementation-pull-request.ts";
import { implementationPullRequestTitle } from "../server/implementation-publication.ts";

const changeId = "delivery-gate";
const root = "a".repeat(40);
const delivery = "b".repeat(40);
const finalHead = "c".repeat(40);
const rebasedRootHead = "d".repeat(40);
const changeBranch = `change/${changeId}`;
const implementationBranch = `implementation/${changeId}/phase-1/run-1`;
const repository = {
  host: "github.com",
  nameWithOwner: "example/project",
  url: "https://github.com/example/project",
};

function run(publicationKind = "ready-pr") {
  return {
    changeId,
    changeBranch,
    implementationBranch,
    rootBaselineCommit: root,
    repository,
    publication: {
      kind: publicationKind,
      number: 51,
      url: "https://github.com/example/project/pull/51",
      title: implementationPullRequestTitle(changeId),
    },
    batch: { kind: "empty", baseCommit: finalHead },
    lastDeliveryHead: delivery,
    processedFeedbackFingerprints: [],
  };
}

function pullRequest(state, isDraft = false, mergedRoot = finalHead) {
  return {
    number: 51,
    url: "https://github.com/example/project/pull/51",
    state,
    isDraft,
    isCrossRepository: false,
    baseRefName: changeBranch,
    headRefName: implementationBranch,
    headRefOid: finalHead,
    mergeCommit: state === "MERGED" ? { oid: mergedRoot } : null,
    title: implementationPullRequestTitle(changeId),
    body: "Описание пользователя",
  };
}

function ciCheck(id, conclusion, status = "COMPLETED") {
  return {
    __typename: "CheckRun", id, name: "tests", status, conclusion,
    startedAt: "2026-09-23T10:00:00Z",
    completedAt: status === "COMPLETED" ? "2026-09-23T10:01:00Z" : null,
    permalink: `https://github.com/example/project/runs/${id}`,
    checkSuite: { id: "suite-one", workflowRun: null },
  };
}

function emptyGraphQl(query, options = {}) {
  if (query.includes("headRefOid statusCheckRollup")) {
    const selected = options.ciRollups?.[options.ciRead] ?? null;
    const ciRollup = selected && (query.includes("contexts(first:1)")
      ? { id: "ci-rollup", contexts: { totalCount: selected.length } }
      : {
        id: "ci-rollup", commit: { oid: finalHead },
        contexts: { nodes: selected, pageInfo: { hasNextPage: false, endCursor: null }, totalCount: selected.length },
      });
    return JSON.stringify({ data: { repository: { pullRequest: {
      headRefOid: finalHead,
      statusCheckRollup: ciRollup,
      potentialMergeCommit: null,
    } } } });
  }
  if (query.includes("query($id:ID!,$after:String){node")) {
    return JSON.stringify({ data: { node: {
      id: "failed", summary: "Tests failed", text: "Assertion failed",
      annotations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 },
    } } });
  }
  const page = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  const field = query.includes("reviewThreads(first")
    ? "reviewThreads"
    : query.includes("reviews(first")
      ? "reviews"
      : "comments";
  return JSON.stringify({ data: { repository: { pullRequest: {
    [field]: field === "comments" && options.comment
      ? { ...page, nodes: [{ id: "comment-one", updatedAt: "2026-09-23T10:00:00Z", body: options.comment, isMinimized: false }] }
      : page,
  } } } });
}

function gateCommand(options = {}) {
  let branch = options.branch ?? implementationBranch;
  let head = options.head ?? finalHead;
  let localRoot = options.localRoot ?? root;
  const remoteRoot = options.remoteRoot ?? root;
  let pr = options.pullRequest ?? pullRequest("OPEN");
  let ciRead = 0;
  const calls = [];
  const command = async (executable, arguments_) => {
    calls.push([executable, ...arguments_]);
    const joined = arguments_.join(" ");
    if (executable === "gh" && arguments_[0] === "pr" && arguments_[1] === "view") {
      return { stdout: JSON.stringify(pr), stderr: "" };
    }
    if (executable === "gh" && arguments_[0] === "api") {
      const query = arguments_[arguments_.indexOf("-f") + 1].slice("query=".length);
      const stdout = emptyGraphQl(query, { ...options, ciRead: Math.min(ciRead, (options.ciRollups?.length ?? 1) - 1) });
      if (query.includes("headRefOid statusCheckRollup") && query.includes("contexts(first:1)")) ciRead += 1;
      return { stdout, stderr: "" };
    }
    if (executable === "gh" && arguments_[0] === "pr" && arguments_[1] === "ready") {
      pr = { ...pr, isDraft: arguments_.includes("--undo") };
      return { stdout: "", stderr: "" };
    }
    if (executable === "gh" && arguments_[0] === "auth") return { stdout: "", stderr: "" };
    if (executable === "gh" && arguments_[0] === "repo") {
      return {
        stdout: JSON.stringify({ nameWithOwner: repository.nameWithOwner, url: repository.url }),
        stderr: "",
      };
    }
    if (executable === "git" && joined === "status --porcelain=v1 --untracked-files=all") {
      return { stdout: "", stderr: "" };
    }
    if (executable === "git" && joined === "branch --show-current") {
      return { stdout: `${branch}\n`, stderr: "" };
    }
    if (executable === "git" && joined === "rev-parse HEAD") {
      return { stdout: `${head}\n`, stderr: "" };
    }
    if (executable === "git" && joined === "rev-parse FETCH_HEAD") {
      return { stdout: `${options.fetchedRoot ?? finalHead}\n`, stderr: "" };
    }
    if (executable === "git" && arguments_[0] === "for-each-ref") {
      return { stdout: `${localRoot}\0refs/heads/${changeBranch}\n`, stderr: "" };
    }
    if (executable === "git" && arguments_[0] === "ls-remote") {
      const ref = arguments_.at(-1);
      const value = ref === `refs/heads/${changeBranch}`
        ? remoteRoot
        : options.remoteImplementation === null
          ? null
          : finalHead;
      if (value === null) return { stdout: "", stderr: "" };
      return { stdout: `${value}\t${ref}\n`, stderr: "" };
    }
    if (executable === "git" && joined === "remote get-url origin") {
      return { stdout: "git@github.com:example/project.git\n", stderr: "" };
    }
    if (executable === "git" && arguments_[0] === "fetch") return { stdout: "", stderr: "" };
    if (executable === "git" && arguments_[0] === "merge-base") {
      if (arguments_[2] === options.nonAncestor) throw new Error("not an ancestor");
      return { stdout: "", stderr: "" };
    }
    if (executable === "git" && arguments_[0] === "switch") {
      branch = changeBranch;
      head = localRoot;
      return { stdout: "", stderr: "" };
    }
    if (executable === "git" && arguments_[0] === "merge") {
      head = options.fetchedRoot ?? finalHead;
      localRoot = options.fetchedRoot ?? finalHead;
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Неожиданная команда: ${executable} ${joined}`);
  };
  return { command, calls };
}

test("Ready gate отдаёт merge приоритетнее feedback и фиксирует финальный head", async () => {
  const harness = gateCommand({
    pullRequest: pullRequest("MERGED"),
    remoteRoot: finalHead,
  });
  const result = await createImplementationPullRequestService({
    command: harness.command,
  }).inspectReadyGate("/workspace", run());
  assert.equal(result.kind, "merged");
  assert.equal(result.session.finalImplementationHead, finalHead);
  assert.equal(harness.calls.some((call) => call[0] === "gh" && call[1] === "api"), false);
});

test("merged gate допускает автоматически удалённую remote implementation-ветку", async () => {
  const harness = gateCommand({
    pullRequest: pullRequest("MERGED"),
    remoteRoot: finalHead,
    remoteImplementation: null,
  });
  const result = await createImplementationPullRequestService({
    command: harness.command,
  }).inspectReadyGate("/workspace", run());
  assert.equal(result.kind, "merged");
  assert.equal(result.session.finalImplementationHead, finalHead);
});

test("Ready transition после рестарта переиспользует уже Ready PR", async () => {
  const harness = gateCommand({ pullRequest: pullRequest("OPEN", false) });
  const result = await createImplementationPullRequestService({
    command: harness.command,
  }).markReady("/workspace", run("draft-pr"));
  assert.deepEqual(result, { kind: "clean" });
  assert.equal(
    harness.calls.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "ready"),
    false,
  );
});

test("открытый Ready PR без нового feedback остаётся в halt-gate", async () => {
  const harness = gateCommand({ pullRequest: pullRequest("OPEN", false) });
  const result = await createImplementationPullRequestService({
    command: harness.command,
  }).inspectReadyGate("/workspace", run());
  assert.deepEqual(result, {
    kind: "open",
    url: "https://github.com/example/project/pull/51",
    number: 51,
  });
});

test("новый CI-сбой и комментарий вместе отправляются в audit", async () => {
  const harness = gateCommand({
    pullRequest: pullRequest("OPEN", true),
    ciRollups: [[ciCheck("failed", "FAILURE")]],
    comment: "Проверьте обработку ошибки",
  });
  const inspection = await createImplementationPullRequestService({ command: harness.command })
    .inspectFeedback("/workspace", run("draft-pr"));
  assert.equal(inspection.kind, "feedback");
  assert.deepEqual(inspection.items.map((item) => item.source), ["comment", "ci-check"]);
});

test("уже разобранный красный CI удерживает Draft PR до нового результата", async () => {
  const harness = gateCommand({
    pullRequest: pullRequest("OPEN", true),
    ciRollups: [[ciCheck("failed", "FAILURE")]],
  });
  const service = createImplementationPullRequestService({ command: harness.command });
  const first = await service.inspectFeedback("/workspace", run("draft-pr"));
  assert.equal(first.kind, "feedback");
  const processed = { ...run("draft-pr"), processedFeedbackFingerprints: [first.items[0].fingerprint] };
  const retry = await service.markReady("/workspace", processed);
  assert.deepEqual(retry, { kind: "blocked", checks: ["tests"] });
  assert.equal(harness.calls.some((call) => call[1] === "pr" && call[2] === "ready"), false);
});

test("зелёный повторный запуск снимает блокировку обработанного CI-сбоя", async () => {
  const harness = gateCommand({
    pullRequest: pullRequest("OPEN", true),
    ciRollups: [[ciCheck("failed", "FAILURE")], [ciCheck("passed", "SUCCESS")]],
  });
  const service = createImplementationPullRequestService({ command: harness.command });
  const failed = await service.inspectFeedback("/workspace", run("draft-pr"));
  assert.equal(failed.kind, "feedback");
  const processed = { ...run("draft-pr"), processedFeedbackFingerprints: [failed.items[0].fingerprint] };
  assert.deepEqual(await service.markReady("/workspace", processed), { kind: "clean" });
  assert.equal(harness.calls.some((call) => call[1] === "pr" && call[2] === "ready" && !call.includes("--undo")), true);
});

test("pending CI останавливает Ready-переход и остаётся pending на Retry", async () => {
  const pendingCheck = ciCheck("queued", null, "QUEUED");
  const draft = gateCommand({ pullRequest: pullRequest("OPEN", true), ciRollups: [[pendingCheck]] });
  assert.deepEqual(
    await createImplementationPullRequestService({ command: draft.command }).markReady("/workspace", run("draft-pr")),
    { kind: "pending", checks: ["tests"] },
  );
  assert.equal(draft.calls.some((call) => call[1] === "pr" && call[2] === "ready"), false);

  const ready = gateCommand({ pullRequest: pullRequest("OPEN", false), ciRollups: [[pendingCheck]] });
  assert.deepEqual(
    await createImplementationPullRequestService({ command: ready.command }).inspectReadyGate("/workspace", run()),
    { kind: "pending", checks: ["tests"] },
  );
});

test("новый CI-сбой на Retry возвращает Ready PR в Draft", async () => {
  const harness = gateCommand({ pullRequest: pullRequest("OPEN", false), ciRollups: [[ciCheck("failed", "FAILURE")]] });
  const inspection = await createImplementationPullRequestService({ command: harness.command })
    .inspectReadyGate("/workspace", run());
  assert.equal(inspection.kind, "feedback");
  assert.equal(inspection.items[0].source, "ci-check");
  assert.equal(harness.calls.some((call) => call[1] === "pr" && call[2] === "ready" && call.includes("--undo")), true);
});

test("CI-сбой, появившийся сразу после Ready, возвращает PR в Draft", async () => {
  const harness = gateCommand({
    pullRequest: pullRequest("OPEN", true),
    ciRollups: [[], [ciCheck("failed", "FAILURE")]],
  });
  const inspection = await createImplementationPullRequestService({ command: harness.command })
    .markReady("/workspace", run("draft-pr"));
  assert.equal(inspection.kind, "feedback");
  const readyCalls = harness.calls.filter((call) => call[1] === "pr" && call[2] === "ready");
  assert.equal(readyCalls.length, 2);
  assert.equal(readyCalls[1].includes("--undo"), true);
});

test("pending CI, появившийся сразу после Ready, возвращает PR в Draft", async () => {
  const harness = gateCommand({
    pullRequest: pullRequest("OPEN", true),
    ciRollups: [[], [ciCheck("queued", null, "QUEUED")]],
  });
  const inspection = await createImplementationPullRequestService({ command: harness.command })
    .markReady("/workspace", run("draft-pr"));
  assert.deepEqual(inspection, { kind: "pending", checks: ["tests"] });
  const readyCalls = harness.calls.filter((call) => call[1] === "pr" && call[2] === "ready");
  assert.equal(readyCalls.length, 2);
  assert.equal(readyCalls[1].includes("--undo"), true);
});

test("merge completion восстанавливается после уже выполненного fast-forward", async () => {
  const harness = gateCommand({
    pullRequest: pullRequest("MERGED"),
    remoteRoot: finalHead,
  });
  const service = createImplementationPullRequestService({ command: harness.command });
  const session = {
    changeId,
    changeBranch,
    implementationBranch,
    rootBaselineCommit: root,
    finalImplementationHead: finalHead,
    pullRequestNumber: 51,
  };
  assert.equal(await service.completeMerge("/workspace", run(), session), finalHead);
  assert.equal(await service.completeMerge("/workspace", run(), session), finalHead);
  assert.equal(
    harness.calls.filter((call) => call[0] === "git" && call[1] === "switch").length,
    1,
  );
});

test("merge completion принимает новый SHA после GitHub Rebase and merge", async () => {
  const harness = gateCommand({
    pullRequest: pullRequest("MERGED", false, rebasedRootHead),
    remoteRoot: rebasedRootHead,
    fetchedRoot: rebasedRootHead,
  });
  const session = {
    changeId,
    changeBranch,
    implementationBranch,
    rootBaselineCommit: root,
    finalImplementationHead: finalHead,
    pullRequestNumber: 51,
  };

  assert.equal(
    await createImplementationPullRequestService({ command: harness.command })
      .completeMerge("/workspace", run(), session),
    rebasedRootHead,
  );
});

test("merge completion требует результат merge PR в удалённой root-ветке", async () => {
  const unrelatedMergeCommit = "e".repeat(40);
  const harness = gateCommand({
    pullRequest: pullRequest("MERGED", false, unrelatedMergeCommit),
    remoteRoot: rebasedRootHead,
    fetchedRoot: rebasedRootHead,
    nonAncestor: unrelatedMergeCommit,
  });
  const session = {
    changeId,
    changeBranch,
    implementationBranch,
    rootBaselineCommit: root,
    finalImplementationHead: finalHead,
    pullRequestNumber: 51,
  };

  await assert.rejects(
    createImplementationPullRequestService({ command: harness.command })
      .completeMerge("/workspace", run(), session),
    /не содержит результат merge implementation PR/u,
  );
});

test("открытый PR fail-closed отклоняется при drift remote root", async () => {
  const harness = gateCommand({ remoteRoot: finalHead });
  await assert.rejects(
    createImplementationPullRequestService({ command: harness.command })
      .inspectReadyGate("/workspace", run()),
    /Локальное состояние implementation-run изменилось/u,
  );
});
