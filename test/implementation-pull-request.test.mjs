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

function emptyGraphQl(query) {
  const page = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  const field = query.includes("reviewThreads(first")
    ? "reviewThreads"
    : query.includes("reviews(first")
      ? "reviews"
      : query.includes("comments(first")
        ? "comments"
        : null;
  if (!field) throw new Error("Неожиданный GraphQL-запрос");
  return JSON.stringify({ data: { repository: { pullRequest: { [field]: page } } } });
}

function gateCommand(options = {}) {
  let branch = options.branch ?? implementationBranch;
  let head = options.head ?? finalHead;
  let localRoot = options.localRoot ?? root;
  const remoteRoot = options.remoteRoot ?? root;
  let pr = options.pullRequest ?? pullRequest("OPEN");
  const calls = [];
  const command = async (executable, arguments_) => {
    calls.push([executable, ...arguments_]);
    const joined = arguments_.join(" ");
    if (executable === "gh" && arguments_[0] === "pr" && arguments_[1] === "view") {
      return { stdout: JSON.stringify(pr), stderr: "" };
    }
    if (executable === "gh" && arguments_[0] === "pr" && arguments_[1] === "ready") {
      pr = { ...pr, isDraft: arguments_.includes("--undo") };
      return { stdout: "", stderr: "" };
    }
    if (executable === "gh" && arguments_[0] === "api") {
      const query = arguments_[arguments_.indexOf("-f") + 1].slice("query=".length);
      return { stdout: emptyGraphQl(query), stderr: "" };
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

test("чистый Draft PR становится Ready без запроса CI", async () => {
  const harness = gateCommand({ pullRequest: pullRequest("OPEN", true) });
  const result = await createImplementationPullRequestService({
    command: harness.command,
  }).markReady("/workspace", run("draft-pr"));
  assert.deepEqual(result, { kind: "clean" });
  assert.equal(harness.calls.filter((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "ready").length, 1);
  const graphQlCalls = harness.calls.filter((call) => call[0] === "gh" && call[1] === "api");
  assert.equal(graphQlCalls.length, 6);
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
