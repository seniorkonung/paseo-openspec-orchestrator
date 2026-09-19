import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_FEEDBACK_BODY_BYTES,
  readImplementationPullRequestFeedback,
} from "../server/implementation-feedback-gateway.ts";

const repository = { host: "github.com", nameWithOwner: "example/project" };
const stamp = "2026-09-19T10:00:00Z";

function response(connection, value) {
  return { stdout: JSON.stringify({ data: { repository: { pullRequest: { [connection]: value } } } }), stderr: "" };
}

function page(nodes, hasNextPage = false, endCursor = null) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

test("читает comments, submitted reviews и только unresolved thread comments", async () => {
  const command = async (_executable, arguments_) => {
    const query = arguments_[arguments_.indexOf("-f") + 1];
    if (query.includes("reviewThreads(first")) {
      return response("reviewThreads", page([
        { id: "thread-open", isResolved: false, comments: page([{ id: "thread-comment", updatedAt: stamp, body: "Проверьте ошибку", isMinimized: false }]) },
        { id: "thread-done", isResolved: true, comments: page([{ id: "ignored", updatedAt: stamp, body: "Уже решено", isMinimized: false }]) },
      ]));
    }
    if (query.includes("reviews(first")) {
      return response("reviews", page([
        { id: "review", updatedAt: stamp, body: "Нужна проверка", state: "CHANGES_REQUESTED" },
        { id: "pending", updatedAt: stamp, body: "Черновик", state: "PENDING" },
      ]));
    }
    return response("comments", page([
      { id: "comment", updatedAt: stamp, body: "Обычный комментарий", isMinimized: false },
      { id: "minimized", updatedAt: stamp, body: "Скрыто", isMinimized: true },
    ]));
  };
  const items = await readImplementationPullRequestFeedback(command, "/workspace", repository, 17);
  assert.deepEqual(items.map(({ source, nodeId }) => [source, nodeId]), [
    ["comment", "comment"],
    ["review", "review"],
    ["review-thread-comment", "thread-comment"],
  ]);
  assert.equal(new Set(items.map(({ fingerprint }) => fingerprint)).size, 3);
});

test("полностью проходит пагинацию и меняет fingerprint от edited updatedAt", async () => {
  let commentPage = 0;
  const command = async (_executable, arguments_) => {
    const query = arguments_[arguments_.indexOf("-f") + 1];
    if (query.includes("reviewThreads(first")) return response("reviewThreads", page([]));
    if (query.includes("reviews(first")) return response("reviews", page([]));
    commentPage += 1;
    return response("comments", commentPage === 1
      ? page([{ id: "same", updatedAt: stamp, body: "До правки", isMinimized: false }], true, "cursor-2")
      : page([{ id: "same", updatedAt: "2026-09-19T11:00:00Z", body: "После правки", isMinimized: false }]));
  };
  const items = await readImplementationPullRequestFeedback(command, "/workspace", repository, 17);
  assert.equal(items.length, 2);
  assert.notEqual(items[0].fingerprint, items[1].fingerprint);
  assert.equal(commentPage, 2);
});

test("останавливается на oversized body и неполной пагинации", async () => {
  const oversized = async (_executable, arguments_) => {
    const query = arguments_[arguments_.indexOf("-f") + 1];
    if (query.includes("reviewThreads(first")) return response("reviewThreads", page([]));
    if (query.includes("reviews(first")) return response("reviews", page([]));
    return response("comments", page([{ id: "huge", updatedAt: stamp, body: "я".repeat(MAX_FEEDBACK_BODY_BYTES), isMinimized: false }]));
  };
  await assert.rejects(
    readImplementationPullRequestFeedback(oversized, "/workspace", repository, 17),
    /превышает/u,
  );

  const incomplete = async (_executable, arguments_) => {
    const query = arguments_[arguments_.indexOf("-f") + 1];
    if (query.includes("reviews(first")) return response("reviews", page([]));
    if (query.includes("reviewThreads(first")) return response("reviewThreads", page([]));
    return response("comments", page([], true, null));
  };
  await assert.rejects(
    readImplementationPullRequestFeedback(incomplete, "/workspace", repository, 17),
    /без cursor/u,
  );
});

test("не принимает невалидный GraphQL payload", async () => {
  await assert.rejects(
    readImplementationPullRequestFeedback(
      async () => ({ stdout: JSON.stringify({ data: { repository: null } }), stderr: "" }),
      "/workspace",
      repository,
      17,
    ),
    /невалидный GraphQL/u,
  );
});

test("останавливает зацикленную GraphQL-пагинацию", async () => {
  const command = async (_executable, arguments_) => {
    const query = arguments_[arguments_.indexOf("-f") + 1];
    if (query.includes("reviews(first")) return response("reviews", page([]));
    if (query.includes("reviewThreads(first")) return response("reviewThreads", page([]));
    return response("comments", page([], true, "same-cursor"));
  };
  await assert.rejects(
    readImplementationPullRequestFeedback(command, "/workspace", repository, 17),
    /зацикленную/u,
  );
});
