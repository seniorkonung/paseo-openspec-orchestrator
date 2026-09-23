import assert from "node:assert/strict";
import test from "node:test";
import {
  pendingPrFeedbackReviewSessionSchema,
  prFeedbackCompletionInputSchema,
  prFeedbackReviewPrompt,
} from "../server/pr-feedback-review.ts";

const session = {
  changeId: "feedback-audit",
  changeBranch: "change/feedback-audit",
  implementationBranch: "implementation/feedback-audit/phase-1/run-1",
  rootBaselineCommit: "a".repeat(40),
  rangeHead: "b".repeat(40),
  baselineCommit: "c".repeat(40),
  reportBlob: "d".repeat(40),
  repository: {
    host: "github.com",
    nameWithOwner: "example/project",
    url: "https://github.com/example/project",
  },
  items: [{
    source: "comment",
    nodeId: "IC_kwDOExample",
    updatedAt: "2026-09-19T10:00:00Z",
    body: "Проверьте обработку пустого описания ошибки",
    fingerprint: "e".repeat(64),
  }],
};

test("feedback prompt передаёт перечисленные items и фиксирует range", () => {
  const prompt = prFeedbackReviewPrompt({
    session: pendingPrFeedbackReviewSessionSchema.parse(session),
    reviewRepositoryPath: "openspec/changes/feedback-audit/implementation-review.md",
    alreadyCommitted: false,
  });
  assert.match(prompt, /Workflow data:/u);
  assert.match(prompt, /Inspect only the feedback items listed/u);
  assert.match(prompt, new RegExp(`${session.rootBaselineCommit}\.\.${session.rangeHead}`, "u"));
  assert.match(prompt, /Never.*invoke `gh`/u);
  assert.match(prompt, /never spawn or archive agents/u);
  assert.match(prompt, /Проверьте обработку пустого описания ошибки/u);
});

test("старый checkpoint с CI feedback остаётся читаемым", () => {
  const restored = pendingPrFeedbackReviewSessionSchema.parse({
    ...session,
    items: [...session.items, {
      source: "ci-check",
      nodeId: "CR_kwDOExample",
      updatedAt: "2026-09-23T10:00:00Z",
      body: JSON.stringify({ summary: "Tests failed", failedLogs: "assertion failed" }),
      fingerprint: "f".repeat(64),
      checkName: "tests",
      commitOid: session.rangeHead,
      conclusion: "FAILURE",
      url: "https://github.com/example/project/runs/123",
    }],
  });
  assert.equal(restored.items[0].source, "comment");
  assert.equal(restored.items[1].source, "ci-check");
});

test("feedback recovery не повторяет skill и требует существующий commit", () => {
  const prompt = prFeedbackReviewPrompt({
    session: pendingPrFeedbackReviewSessionSchema.parse(session),
    reviewRepositoryPath: "openspec/changes/feedback-audit/implementation-review.md",
    alreadyCommitted: true,
  });
  assert.match(prompt, /recovery session/u);
  assert.match(prompt, /Do not invoke the review skill/u);
  assert.doesNotMatch(prompt, /If and only if the report materially changes/u);
  assert.match(prompt, /"mode":"report-updated"/u);
});

test("feedback completion принимает только два строгих режима", () => {
  assert.deepEqual(prFeedbackCompletionInputSchema.parse({ mode: "report-updated" }), {
    mode: "report-updated",
  });
  assert.deepEqual(prFeedbackCompletionInputSchema.parse({ mode: "no-report-change" }), {
    mode: "no-report-change",
  });
  assert.throws(() => prFeedbackCompletionInputSchema.parse({ mode: "report-updated", body: "x" }));
});

test("durable feedback session применяет суммарный byte-limit", () => {
  const oversized = {
    ...session,
    items: Array.from({ length: 65 }, (_, index) => ({
      ...session.items[0],
      nodeId: `node-${index}`,
      fingerprint: index.toString(16).padStart(64, "0"),
      body: "x".repeat(64 * 1_024),
    })),
  };
  assert.throws(
    () => pendingPrFeedbackReviewSessionSchema.parse(oversized),
    /Суммарный PR feedback превышает/u,
  );
});
