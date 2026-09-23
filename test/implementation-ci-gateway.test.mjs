import assert from "node:assert/strict";
import test from "node:test";
import { readImplementationPullRequestCi } from "../server/implementation-ci-gateway.ts";

const repository = { host: "github.com", nameWithOwner: "example/project" };
const head = "a".repeat(40);
const merge = "b".repeat(40);
const firstTime = "2026-09-23T10:00:00Z";
const laterTime = "2026-09-23T10:10:00Z";
const pageInfo = (hasNextPage = false, endCursor = null) => ({ hasNextPage, endCursor });
const rollup = (id, oid, nodes, info = pageInfo(), totalCount = nodes.length) => ({
  id, commit: { oid }, contexts: { nodes, pageInfo: info, totalCount },
});

function run(id, conclusion, options = {}) {
  return {
    __typename: "CheckRun",
    id,
    name: options.name ?? "tests",
    status: options.status ?? "COMPLETED",
    conclusion,
    startedAt: options.startedAt ?? firstTime,
    completedAt: options.completedAt ?? firstTime,
    permalink: `https://github.com/example/project/runs/${id}`,
    checkSuite: {
      id: options.suiteId ?? "suite-one",
      workflowRun: options.workflowRun ?? null,
    },
  };
}

function status(id, state, options = {}) {
  return {
    __typename: "StatusContext",
    id,
    context: options.name ?? "external-ci",
    state,
    description: options.description ?? "CI reported a problem",
    targetUrl: options.targetUrl ?? null,
    updatedAt: options.updatedAt ?? firstTime,
    creator: { login: "external" },
  };
}

function harness(options = {}) {
  const calls = [];
  const headRollup = options.headRollup ?? null;
  const mergeRollup = options.mergeRollup ?? null;
  const headOid = options.headOid ?? head;
  const command = async (executable, args) => {
    calls.push([executable, ...args]);
    if (executable === "gh" && args[0] === "run" && args.includes("--json")) {
      if (options.logsUnavailable) throw new Error("logs unavailable");
      return { stdout: JSON.stringify({ headSha: options.logSha ?? head, attempt: options.logAttempt ?? 2 }), stderr: "" };
    }
    if (executable === "gh" && args[0] === "run" && args.includes("--log-failed")) {
      if (options.logsUnavailable) throw new Error("logs unavailable");
      return { stdout: "assertion failed: expected 1, received 2", stderr: "" };
    }
    assert.equal(executable, "gh");
    assert.equal(args[0], "api");
    const query = args[args.indexOf("-f") + 1].slice("query=".length);
    if (query.includes("headRefOid statusCheckRollup")) {
      const verify = query.includes("contexts(first:1)");
      const shorten = (value) => value && ({ id: value.id, contexts: { totalCount: value.contexts.totalCount } });
      const pr = verify
        ? {
          headRefOid: options.verifyHeadOid ?? headOid,
          statusCheckRollup: shorten(headRollup),
          potentialMergeCommit: mergeRollup ? { oid: merge, statusCheckRollup: shorten(mergeRollup) } : null,
        }
        : {
          headRefOid: headOid,
          statusCheckRollup: headRollup,
          potentialMergeCommit: mergeRollup ? { oid: merge, statusCheckRollup: mergeRollup } : null,
        };
      return { stdout: JSON.stringify({ data: { repository: { pullRequest: pr } } }), stderr: "" };
    }
    if (query.includes("... on StatusCheckRollup")) {
      return { stdout: JSON.stringify({ data: { node: options.nextPage } }), stderr: "" };
    }
    if (query.includes("... on CheckRun")) {
      if (options.invalidDetail) return { stdout: JSON.stringify({ data: { node: null } }), stderr: "" };
      return { stdout: JSON.stringify({ data: { node: {
        id: options.detailId ?? "failed",
        summary: options.summary ?? "Tests failed",
        text: options.text ?? "Expected output differs",
        annotations: options.annotationsUnavailable ? null : { nodes: options.annotations ?? [{
          annotationLevel: "FAILURE", path: "src/index.ts",
          location: { start: { line: 7 }, end: { line: 7 } },
          title: "Assertion failed", message: "Expected 1", rawDetails: null,
        }], pageInfo: options.annotationPageInfo ?? pageInfo(), totalCount: options.annotationTotalCount ?? (options.annotations?.length ?? 1) },
      } } }), stderr: "" };
    }
    throw new Error(`Unexpected query ${query}`);
  };
  return { command, calls };
}

test("пустой или зелёный CI не создаёт feedback", async () => {
  const empty = harness();
  assert.deepEqual(await readImplementationPullRequestCi(empty.command, "/workspace", repository, 17, head, new Set()), {
    newFailures: [], failed: [], pending: [], rerunRequired: [],
  });
  const green = harness({ headRollup: rollup("head-rollup", head, [
    run("passed", "SUCCESS"),
    run("neutral", "NEUTRAL", { name: "lint" }),
    run("skipped", "SKIPPED", { name: "optional" }),
    status("status-passed", "SUCCESS"),
  ]) });
  assert.deepEqual(await readImplementationPullRequestCi(green.command, "/workspace", repository, 17, head, new Set()), {
    newFailures: [], failed: [], pending: [], rerunRequired: [],
  });
});

test("новый сбой с логами и annotations передаётся агенту один раз, оставаясь блокирующим", async () => {
  const failed = run("failed", "FAILURE", {
    workflowRun: { url: "https://github.com/example/project/actions/runs/12345", runAttempt: 2 },
  });
  const input = harness({ headRollup: rollup("head-rollup", head, [failed]) });
  const first = await readImplementationPullRequestCi(input.command, "/workspace", repository, 17, head, new Set());
  assert.deepEqual(first.failed, ["tests"]);
  assert.equal(first.newFailures.length, 1);
  assert.equal(first.newFailures[0].source, "ci-check");
  assert.equal(first.newFailures[0].commitOid, head);
  assert.match(first.newFailures[0].body, /Expected output differs/u);
  assert.match(first.newFailures[0].body, /assertion failed/u);
  assert.equal(input.calls.some((call) => call.includes("--log-failed")), true);

  const retry = harness({ headRollup: rollup("head-rollup", head, [failed]) });
  const second = await readImplementationPullRequestCi(retry.command, "/workspace", repository, 17, head, new Set([first.newFailures[0].fingerprint]));
  assert.deepEqual(second.failed, ["tests"]);
  assert.deepEqual(second.newFailures, []);
  assert.equal(retry.calls.some((call) => call.includes("--log-failed")), false);
});

test("повторный запуск обновляет fingerprint, а старый упавший запуск не блокирует зелёный", async () => {
  const old = run("old", "FAILURE");
  const newer = run("new", "SUCCESS", { startedAt: laterTime, completedAt: laterTime });
  const input = harness({ headRollup: rollup("head-rollup", head, [old, newer]) });
  const result = await readImplementationPullRequestCi(input.command, "/workspace", repository, 17, head, new Set());
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.newFailures, []);

  const rerun = harness({ headRollup: rollup("head-rollup", head, [
    run("failed", "FAILURE", { startedAt: laterTime, completedAt: laterTime }),
  ]) });
  const changed = await readImplementationPullRequestCi(rerun.command, "/workspace", repository, 17, head, new Set());
  assert.equal(changed.newFailures.length, 1);
});

test("одноимённые проверки разных suites учитываются независимо, новый queued запуск заменяет старый сбой", async () => {
  const separate = harness({ detailId: "suite-a-failed", headRollup: rollup("head-rollup", head, [
    run("suite-a-failed", "FAILURE", { suiteId: "suite-a" }),
    run("suite-b-passed", "SUCCESS", { suiteId: "suite-b" }),
  ]) });
  const result = await readImplementationPullRequestCi(separate.command, "/workspace", repository, 17, head, new Set());
  assert.deepEqual(result.failed, ["tests"]);
  assert.equal(result.newFailures[0].nodeId, "suite-a-failed");

  const rerunning = harness({ headRollup: rollup("head-rollup", head, [
    run("old-failed", "FAILURE"),
    run("new-queued", null, { status: "QUEUED", startedAt: null, completedAt: null }),
  ]) });
  const pending = await readImplementationPullRequestCi(rerunning.command, "/workspace", repository, 17, head, new Set());
  assert.deepEqual(pending.failed, []);
  assert.deepEqual(pending.pending, ["tests"]);
});

test("изменившийся результат commit status получает новый fingerprint", async () => {
  const first = harness({ headRollup: rollup("head-rollup", head, [status("same", "FAILURE")]) });
  const old = await readImplementationPullRequestCi(first.command, "/workspace", repository, 17, head, new Set());
  const updated = harness({ headRollup: rollup("head-rollup", head, [status("same", "ERROR", { updatedAt: laterTime })]) });
  const current = await readImplementationPullRequestCi(updated.command, "/workspace", repository, 17, head, new Set([old.newFailures[0].fingerprint]));
  assert.equal(current.newFailures.length, 1);
  assert.notEqual(current.newFailures[0].fingerprint, old.newFailures[0].fingerprint);
  assert.equal(current.newFailures[0].conclusion, "ERROR");
});

test("повторные статусы сравниваются по абсолютному времени", async () => {
  const input = harness({ headRollup: rollup("head-rollup", head, [
    status("old-offset", "FAILURE", { updatedAt: "2026-09-23T12:00:00+03:00" }),
    status("new-utc", "SUCCESS", { updatedAt: "2026-09-23T10:00:00Z" }),
  ]) });
  const result = await readImplementationPullRequestCi(input.command, "/workspace", repository, 17, head, new Set());
  assert.deepEqual(result.failed, []);
});

test("pending, cancelled и stale останавливают gate без finding", async () => {
  const input = harness({ headRollup: rollup("head-rollup", head, [
    run("queued", null, { name: "build", status: "QUEUED", completedAt: null }),
    run("cancelled", "CANCELLED", { name: "cancelled-job" }),
    run("stale", "STALE", { name: "stale-job" }),
    status("expected", "EXPECTED", { name: "required" }),
  ]) });
  const result = await readImplementationPullRequestCi(input.command, "/workspace", repository, 17, head, new Set());
  assert.deepEqual(result.pending, ["build", "required"]);
  assert.deepEqual(result.rerunRequired, ["cancelled-job", "stale-job"]);
  assert.deepEqual(result.newFailures, []);
});

test("CI тестового merge-коммита имеет приоритет над head CI", async () => {
  const input = harness({
    headRollup: rollup("head-rollup", head, [run("head-failed", "FAILURE")]),
    mergeRollup: rollup("merge-rollup", merge, [status("merge-failed", "ERROR")]),
  });
  const result = await readImplementationPullRequestCi(input.command, "/workspace", repository, 17, head, new Set());
  assert.deepEqual(result.failed, ["external-ci"]);
  assert.equal(result.newFailures[0].commitOid, merge);
  assert.equal(result.newFailures[0].conclusion, "ERROR");
  assert.equal(input.calls.some((call) => call.includes("--log-failed")), false);
});

test("CI gateway отклоняет неполную пагинацию и смену head SHA", async () => {
  const incomplete = harness({ headRollup: rollup("head-rollup", head, [], pageInfo(true, null), 1) });
  await assert.rejects(readImplementationPullRequestCi(incomplete.command, "/workspace", repository, 17, head, new Set()), /пагинацию/u);
  const drift = harness({ headRollup: rollup("head-rollup", head, [], pageInfo(), 0), verifyHeadOid: merge });
  await assert.rejects(readImplementationPullRequestCi(drift.command, "/workspace", repository, 17, head, new Set()), /изменились/u);
  const wrongHead = harness({ headOid: merge });
  await assert.rejects(readImplementationPullRequestCi(wrongHead.command, "/workspace", repository, 17, head, new Set()), /Head implementation PR/u);
});

test("CI gateway проходит все страницы и отвергает дублированные checks", async () => {
  const firstPage = rollup("head-rollup", head, [run("passed", "SUCCESS", { name: "lint" })], pageInfo(true, "next"), 2);
  const input = harness({
    headRollup: firstPage,
    nextPage: rollup("head-rollup", head, [status("status-failed", "FAILURE")], pageInfo(), 2),
  });
  const result = await readImplementationPullRequestCi(input.command, "/workspace", repository, 17, head, new Set());
  assert.deepEqual(result.failed, ["external-ci"]);
  assert.equal(result.newFailures[0].source, "ci-check");

  const duplicate = harness({
    headRollup: rollup("head-rollup", head, [status("same", "SUCCESS"), status("same", "FAILURE")]),
  });
  await assert.rejects(readImplementationPullRequestCi(duplicate.command, "/workspace", repository, 17, head, new Set()), /дублированные/u);
});

test("невалидные детали CI и незавершённые annotations не становятся подтверждённым feedback", async () => {
  const headRollup = rollup("head-rollup", head, [run("failed", "FAILURE")]);
  const invalid = harness({ headRollup, invalidDetail: true });
  await assert.rejects(readImplementationPullRequestCi(invalid.command, "/workspace", repository, 17, head, new Set()), /невалидные детали/u);
  const incomplete = harness({ headRollup, annotationPageInfo: pageInfo(true, null) });
  await assert.rejects(readImplementationPullRequestCi(incomplete.command, "/workspace", repository, 17, head, new Set()), /пагинацию/u);
  const missing = harness({ headRollup, annotationTotalCount: 2 });
  await assert.rejects(readImplementationPullRequestCi(missing.command, "/workspace", repository, 17, head, new Set()), /полностью прочитать CI annotations/u);
});

test("недоступные annotations не мешают передать summary упавшего check", async () => {
  const input = harness({
    headRollup: rollup("head-rollup", head, [run("failed", "FAILURE")]),
    annotationsUnavailable: true,
  });
  const result = await readImplementationPullRequestCi(input.command, "/workspace", repository, 17, head, new Set());
  const body = JSON.parse(result.newFailures[0].body);
  assert.equal(body.summary, "Tests failed");
  assert.equal(body.annotations, "[]");
});

test("недоступные логи не подменяются внешней ссылкой, а большой payload ограничен", async () => {
  const failed = run("failed", "FAILURE");
  const input = harness({ headRollup: rollup("head-rollup", head, [failed]), logsUnavailable: true });
  const result = await readImplementationPullRequestCi(input.command, "/workspace", repository, 17, head, new Set());
  assert.equal(result.newFailures.length, 1);
  assert.equal(input.calls.some((call) => call[1] === "run"), false);
  assert.equal(JSON.parse(result.newFailures[0].body).failedLogs, "");

  const externalStatus = harness({ headRollup: rollup("head-rollup", head, [status("status-failed", "FAILURE", {
    targetUrl: "https://evil.example/actions/runs/123",
  })]) });
  const external = await readImplementationPullRequestCi(externalStatus.command, "/workspace", repository, 17, head, new Set());
  assert.equal(externalStatus.calls.some((call) => call[1] === "run"), false);
  assert.equal(external.newFailures[0].url, "https://evil.example/actions/runs/123");

  const externalRun = harness({ headRollup: rollup("head-rollup", head, [run("failed", "FAILURE", {
    workflowRun: { url: "https://evil.example/example/project/actions/runs/12345", runAttempt: 2 },
  })]) });
  const untrusted = await readImplementationPullRequestCi(externalRun.command, "/workspace", repository, 17, head, new Set());
  assert.equal(externalRun.calls.some((call) => call[1] === "run"), false);
  assert.equal(JSON.parse(untrusted.newFailures[0].body).failedLogs, "");

  const unavailable = harness({
    headRollup: rollup("head-rollup", head, [run("failed", "FAILURE", {
      workflowRun: { url: "https://github.com/example/project/actions/runs/12345", runAttempt: 2 },
    })]),
    logsUnavailable: true,
  });
  const withoutLogs = await readImplementationPullRequestCi(unavailable.command, "/workspace", repository, 17, head, new Set());
  assert.equal(unavailable.calls.some((call) => call[1] === "run"), true);
  assert.equal(JSON.parse(withoutLogs.newFailures[0].body).failedLogs, "");

  const staleAttempt = harness({
    headRollup: rollup("head-rollup", head, [run("failed", "FAILURE", {
      workflowRun: { url: "https://github.com/example/project/actions/runs/12345", runAttempt: 1 },
    })]),
  });
  const stale = await readImplementationPullRequestCi(staleAttempt.command, "/workspace", repository, 17, head, new Set());
  assert.equal(staleAttempt.calls.some((call) => call.includes("--log-failed")), false);
  assert.equal(JSON.parse(stale.newFailures[0].body).failedLogs, "");

  const huge = harness({ headRollup: rollup("head-rollup", head, [run("failed", "FAILURE")]), text: "ошибка".repeat(30_000) });
  const bounded = await readImplementationPullRequestCi(huge.command, "/workspace", repository, 17, head, new Set());
  assert.ok(Buffer.byteLength(bounded.newFailures[0].body, "utf8") < 64 * 1_024);
  assert.match(bounded.newFailures[0].body, /усечено/u);
});
