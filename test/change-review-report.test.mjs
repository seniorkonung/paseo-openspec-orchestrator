import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_CHANGE_REVIEW_BYTES,
  MAX_CHANGE_REVIEW_FINDINGS,
  parseChangeReviewReport,
  readChangeReviewReport,
} from "../server/change-review-report.ts";

const changeId = "resolve-review-findings";

function finding(id, severity = "High", title = `Проблема ${id}`) {
  return `### ${id} · ${severity} — ${title}

- **Evidence:** Артефакт не определяет обязательное поведение.
- **Impact:** Реализация может выбрать несовместимое поведение.
- **Required change:** Зафиксировать проверяемый контракт.`;
}

function report({
  findings = [],
  acceptedRisks = "",
  coverageStatus = "Complete",
  result = findings.length > 0
    ? "Changes needed"
    : coverageStatus === "Incomplete"
      ? "Review incomplete"
      : "No unresolved findings",
  summary = acceptedRisks ? "Известен принятый риск AR1." : "Проверка завершена.",
} = {}) {
  const findingsBody = findings.length > 0
    ? findings.join("\n\n")
    : coverageStatus === "Incomplete"
      ? "No findings confirmed; review incomplete."
      : "No unresolved findings remain in the reviewed change artifacts and relevant repository context.";
  const limitations = coverageStatus === "Incomplete"
    ? "\n**Coverage limitations:** Недоступен обязательный внешний контракт."
    : "";
  const risksSection = acceptedRisks ? `\n\n## Accepted risks\n\n${acceptedRisks}` : "";
  return `# OpenSpec Change Review: ${changeId}

## Assessment

**Format version:** 1
**Result:** ${result}
**Coverage status:** ${coverageStatus}${limitations}
**Summary:** ${summary}
**Validation:** openspec validate выполнен успешно.

## Findings

${findingsBody}${risksSection}

## Review coverage

Проверены intent, behavioral contract, decisions, work и verification.
`;
}

const acceptedRisk = `### AR1 · Поддержка legacy-топологии не планируется

- **Evidence:** Legacy-топология остаётся в эксплуатации.
- **Potential impact:** Миграция может потребовать ручного отката.
- **Acceptance rationale:** Дополнительный путь удваивает стоимость поддержки.
- **Scope and assumptions:** Только legacy tenants до конца миграции.
- **Reopen when:** Срок миграции будет продлён.
- **Acceptance authority:** Пользователь явно принял риск.
- **Originating finding:** F9
- **Acceptance lifetime:** Change-scoped`;

test("parser сохраняет порядок активных findings и игнорирует accepted risks", () => {
  const parsed = parseChangeReviewReport(
    report({
      findings: [finding("F7", "Medium"), finding("F2", "Low")],
      acceptedRisks: acceptedRisk,
      summary: "Остаются findings F7 и F2; принят риск AR1.",
    }),
    changeId,
  );

  assert.deepEqual(parsed.findings.map(({ id }) => id), ["F7", "F2"]);
  assert.deepEqual(parsed.acceptedRisks, [
    { originatingFindingId: "F9" },
  ]);
});

test("parser одинаково трактует чистый и неполный review без finding-заголовков", () => {
  assert.deepEqual(parseChangeReviewReport(report(), changeId).findings, []);
  const incomplete = parseChangeReviewReport(
    report({ coverageStatus: "Incomplete" }),
    changeId,
  );
  assert.deepEqual(incomplete.findings, []);
});

test("parser молча игнорирует формат отчёта и дедуплицирует finding-заголовки", () => {
  const parsed = parseChangeReviewReport([
    "неизвестный формат без обязательных разделов",
    "### F2: Короткий заголовок",
    "### F2 · Повтор",
    "**Result:** противоречивое значение",
    "### F999999999999999999999999999999999: слишком длинный ID",
    "```markdown",
    "### F3 · Это только пример",
    "```",
  ].join("\n"), "other-change");

  assert.deepEqual(parsed.findings, [{ id: "F2" }]);
});

test("parser молча ограничивает число активных findings", () => {
  const findings = Array.from(
    { length: MAX_CHANGE_REVIEW_FINDINGS + 1 },
    (_, index) => finding(`F${index + 1}`),
  );
  assert.equal(
    parseChangeReviewReport(report({ findings }), changeId).findings.length,
    MAX_CHANGE_REVIEW_FINDINGS,
  );
});

test("чтение отчёта отклоняет symlink, выход за change, oversized и неверный UTF-8", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "openspec-review-report-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const changeRoot = join(root, "change");
  const otherRoot = join(root, "other");
  await mkdir(changeRoot);
  await mkdir(otherRoot);
  const validPath = join(changeRoot, "review.md");
  await writeFile(validPath, report());

  assert.deepEqual((await readChangeReviewReport({
    reviewPath: validPath,
    changeRoot,
    expectedChangeId: changeId,
  })).findings, []);

  const outsidePath = join(otherRoot, "review.md");
  await writeFile(outsidePath, report());
  await assert.rejects(
    readChangeReviewReport({ reviewPath: outsidePath, changeRoot, expectedChangeId: changeId }),
    /за пределами/,
  );

  const linkPath = join(changeRoot, "linked-review.md");
  await symlink("review.md", linkPath);
  await assert.rejects(
    readChangeReviewReport({ reviewPath: linkPath, changeRoot, expectedChangeId: changeId }),
    /обычным файлом/,
  );

  await writeFile(validPath, Buffer.alloc(MAX_CHANGE_REVIEW_BYTES + 1, 0x61));
  await assert.rejects(
    readChangeReviewReport({ reviewPath: validPath, changeRoot, expectedChangeId: changeId }),
    /размер/,
  );

  await writeFile(validPath, Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    readChangeReviewReport({ reviewPath: validPath, changeRoot, expectedChangeId: changeId }),
    /UTF-8/,
  );
});
