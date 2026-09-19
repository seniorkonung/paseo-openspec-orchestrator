import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ImplementationReviewReportError,
  MAX_IMPLEMENTATION_REVIEW_BYTES,
  MAX_IMPLEMENTATION_REVIEW_FINDINGS,
  parseImplementationReviewReport,
  readImplementationReviewReport,
} from "../server/implementation-review-report.ts";

const changeId = "persist-export";
const base = "a".repeat(40);
const head = "b".repeat(40);

function finding(id, severity = "High") {
  return `### ${id} · ${severity} — Проблема ${id}

- **Evidence:** src/export.js подтверждает запрос до сохранения.
- **Evidence revisions:** ["${head}"]
- **Impact:** Пользователь может потерять подтверждённый экспорт.
- **Required outcome:** Успех означает доступный экспорт.
- **Earliest source of truth:** implementation/tests
- **Affected artifacts:** ["src/export.js", "openspec/changes/${changeId}/spec.md"]`;
}

function acceptedRisk(id, origin) {
  return `### ${id} · Ручной rollback legacy

- **Evidence:** Legacy deployment не имеет автоматического rollback.
- **Evidence revisions:** ["${base}"]
- **Potential impact:** Восстановление занимает больше времени.
- **Acceptance rationale:** Автоматизация дороже ограниченного риска.
- **Scope and assumptions:** Только legacy deployments сентября 2026.
- **Reopen when:** Срок миграции будет продлён.
- **Acceptance authority:** Пользователь явно принял риск.
- **Originating finding:** ${origin}
- **Acceptance lifetime:** Change-scoped`;
}

function implementationReview({
  findingIds = ["F2", "F7"],
  acceptedRisks = [acceptedRisk("AR1", "F1")],
  coverage = "Complete",
  passStatuses = ["Complete", "Complete", "Complete"],
  reportedChangeId = changeId,
} = {}) {
  const findings = findingIds.length > 0
    ? findingIds.map((id) => finding(id)).join("\n\n")
    : coverage === "Incomplete"
      ? "No findings confirmed; review incomplete."
      : "No unresolved findings remain in the implementation review.";
  const risks = acceptedRisks.length > 0
    ? `\n\n## Accepted risks\n\n${acceptedRisks.join("\n\n")}`
    : "";
  const result = findingIds.length > 0
    ? "Changes needed"
    : coverage === "Incomplete"
      ? "Incomplete"
      : "No unresolved findings";
  const summary = acceptedRisks.length > 0
    ? `Требуется решение findings; AR1 остаётся принятым.`
    : findingIds.length > 0
      ? "Требуется решение findings."
      : "Нерешённых findings нет.";
  const limitations = coverage === "Incomplete"
    ? "\n**Coverage limitations:** Не завершена независимая проверка."
    : "";
  const units = coverage === "Incomplete"
    ? "No review units could be established."
    : `### U1 · Сохранять до подтверждения

- **Work items:** ["1.1"]
- **Requirements and scenarios:** ["Export: persisted acknowledgement"]
- **Affected boundary:** Клиенты Export API.
- **Implementation target:** ["src/export.js"]
- **Applicable constraints and non-goals:** Сохранить текущий success contract.`;
  const reviewablePaths = coverage === "Incomplete"
    ? `["src/export.js"]`
    : `["src/export.js", "openspec/changes/${changeId}/spec.md"]`;
  const planningEvidence = coverage === "Incomplete"
    ? ""
    : `\n- **Planning evidence paths:** ["openspec/changes/${changeId}/spec.md"]`;
  const unmapped = coverage === "Incomplete"
    ? `\n\n## Unmapped range\n\n- **Unmatched target paths:** ["src/export.js"]\n- **Reason:** Не удалось установить mapping.`
    : "";

  return `# OpenSpec Implementation Review: ${reportedChangeId}

## Assessment

**Format version:** 1
**Result:** ${result}
**Coverage status:** ${coverage}${limitations}
**Summary:** ${summary}

## Review target

- **Baseline ref:** review-start
- **Base commit:** ${base}
- **Reviewed head:** ${head}
- **Target commits:** ["${head}"]
- **Reviewable paths:** ${reviewablePaths}
- **OpenSpec change:** ${reportedChangeId}
- **OpenSpec schema:** spec-driven
- **Target scope:** User-requested bounded range
- **Baseline freshness:** Local ref state; no fetch performed${planningEvidence}

## Reviewed increment

${units}${unmapped}

## Pass coverage

| Pass | Status | Evidence or limitation |
|---|---|---|
| Independent decision review | ${passStatuses[0]} | Изолированный reviewer проверил target. |
| OpenSpec conformance | ${passStatuses[1]} | Проверены требования и тесты. |
| Code quality | ${passStatuses[2]} | Проверены ошибки и callers. |

## Findings

${findings}${risks}

## Review coverage

Проверены persistence, failures и callers.
`;
}

test("parser сохраняет порядок implementation findings и исключает accepted risks", () => {
  const parsed = parseImplementationReviewReport(implementationReview(), changeId);

  assert.deepEqual(parsed.findings.map(({ id }) => id), ["F2", "F7"]);
  assert.deepEqual(parsed.acceptedRisks, [
    { originatingFindingId: "F1" },
  ]);
});

test("parser игнорирует originating finding, который нельзя использовать как session ID", () => {
  const parsed = parseImplementationReviewReport(
    implementationReview({
      findingIds: [],
      acceptedRisks: [acceptedRisk("AR1", `F${"9".repeat(64)}`)],
    }),
    changeId,
  );

  assert.deepEqual(parsed.findings, []);
  assert.deepEqual(parsed.acceptedRisks, []);
});

test("parser одинаково трактует чистый и неполный review без finding-заголовков", () => {
  const clean = parseImplementationReviewReport(
    implementationReview({ findingIds: [], acceptedRisks: [] }),
    changeId,
  );
  assert.deepEqual(clean.findings, []);

  const incomplete = parseImplementationReviewReport(
    implementationReview({
      findingIds: [],
      acceptedRisks: [],
      coverage: "Incomplete",
      passStatuses: ["Incomplete", "Complete", "Complete"],
    }),
    changeId,
  );
  assert.deepEqual(incomplete.findings, []);
});

test("parser молча ограничивает число активных implementation findings", () => {
  const findingIds = Array.from(
    { length: MAX_IMPLEMENTATION_REVIEW_FINDINGS + 1 },
    (_, index) => `F${index + 1}`,
  );

  assert.equal(
    parseImplementationReviewReport(implementationReview({ findingIds }), changeId).findings.length,
    MAX_IMPLEMENTATION_REVIEW_FINDINGS,
  );
});

test("parser не проверяет change ID, assessment и coverage", () => {
  const malformed = implementationReview({ reportedChangeId: "other-change" })
    .replace("**Result:** Changes needed", "**Result:** No unresolved findings")
    .replace(
      `- **Planning evidence paths:** ["openspec/changes/${changeId}/spec.md"]`,
      `- **Planning evidence paths:** ["outside.md"]`,
    );

  assert.deepEqual(
    parseImplementationReviewReport(malformed, changeId).findings.map(({ id }) => id),
    ["F2", "F7"],
  );
});

test("чтение implementation review отклоняет symlink, oversized и неверный UTF-8", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "implementation-review-report-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const changeRoot = join(root, "change");
  await mkdir(changeRoot);
  const reviewPath = join(changeRoot, "implementation-review.md");
  const request = { reviewPath, changeRoot, expectedChangeId: changeId };

  const outside = join(root, "outside.md");
  await writeFile(outside, implementationReview());
  await symlink(outside, reviewPath);
  await assert.rejects(readImplementationReviewReport(request), /обычным файлом/);
  await rm(reviewPath);

  await writeFile(reviewPath, Buffer.alloc(MAX_IMPLEMENTATION_REVIEW_BYTES + 1, 0x61));
  await assert.rejects(readImplementationReviewReport(request), /размер|превышает/);

  await writeFile(reviewPath, Buffer.from([0xc3, 0x28]));
  await assert.rejects(readImplementationReviewReport(request), /корректный UTF-8/);
});

test("существующий implementation report обязателен для reader", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "implementation-review-missing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    readImplementationReviewReport({
      reviewPath: join(root, "implementation-review.md"),
      changeRoot: root,
      expectedChangeId: changeId,
    }),
    ImplementationReviewReportError,
  );
});
