import assert from "node:assert/strict";
import test from "node:test";
import {
  FindingDecisionsError,
  bindFindingDecisions,
  findingDecisionsFileName,
  parseFindingDecisions,
  renderFindingDecisions,
  sameFindingDecisions,
  selectFindingWork,
  summarizeFindingDecisions,
  decisionsAfterBlock,
  decisionsAfterResolution,
  findingHeadingSchema,
  openDecisionsChanged,
  withBlockedFindingDecision,
} from "../server/review-finding-decision-model.ts";

const remediate = {
  kind: "remediate",
  instruction: "Описать отмену экспорта в спецификации и добавить задачу на проверку.",
};
const acceptRisk = {
  kind: "accept-risk",
  rationale: "Legacy-топология выводится из эксплуатации до релиза.",
  scope: "Только legacy tenants до конца миграции.",
  reopenWhen: "Миграция будет отложена.",
};

function record(findingId, decision, heading = `${findingId} · High — Проблема ${findingId}`) {
  return { findingId, heading, decision };
}

const records = [
  record("F1", remediate),
  record("F3", acceptRisk),
  record("F4", { kind: "blocked", reason: "Решение противоречит контракту публичного API." }),
];

test("файлы решений названы по виду ревью", () => {
  assert.equal(findingDecisionsFileName("review"), "review-decisions.md");
  assert.equal(
    findingDecisionsFileName("implementation-review"),
    "implementation-review-decisions.md",
  );
});

test("файл решений читается в те же записи, из которых сгенерирован", () => {
  for (const kind of ["review", "implementation-review"]) {
    const source = renderFindingDecisions(kind, records);
    assert.deepEqual(parseFindingDecisions(kind, source), records);
    assert.deepEqual(parseFindingDecisions(kind, renderFindingDecisions(kind, [])), []);
    // CRLF и BOM после ручного редактирования не меняют смысл файла.
    assert.deepEqual(
      parseFindingDecisions(kind, `﻿${source.replace(/\n/gu, "\r\n")}`),
      records,
    );
  }
  assert.equal(
    renderFindingDecisions("review", [records[0]]),
    `# Решения по findings OpenSpec review

<!-- paseo-openspec-orchestrator:finding-decisions:v1 -->

Файл ведёт оркестратор. Решения приняты пользователем в сессии решений и исполняются автономно, по одной finding за сессию. Сессия исполнения удаляет раздел своей finding в коммите её устранения.

## F1 · High — Проблема F1

- **Решение:** Устранить
- **Как устранить:** Описать отмену экспорта в спецификации и добавить задачу на проверку.
`,
  );
});

test("разбор файла решений отклоняет любое отклонение от формата с объяснением", () => {
  const valid = renderFindingDecisions("review", records);
  const cases = [
    [valid.replace("# Решения по findings OpenSpec review", "# Решения"), /первая строка должна быть/u],
    [renderFindingDecisions("implementation-review", records), /первая строка должна быть/u],
    [valid.replace("<!-- paseo-openspec-orchestrator:finding-decisions:v1 -->", ""), /нет служебного marker/u],
    [valid.replace("## F3 · High", "## F1 · High"), /решение по F1 повторяется/u],
    [valid.replace("## F3 · High — Проблема F3", "## Без ID"), /некорректный заголовок решения/u],
    [valid.replace("- **Решение:** Устранить", "- **Решение:** Отложить"), /поле «Решение» должно быть одним из/u],
    [valid.replace("- **Обоснование:**", "- **Почему:**"), /строка 2 должна начинаться с «- \*\*Обоснование:\*\*»/u],
    [valid.replace(remediate.instruction, "Describe export cancellation."), /должен быть на русском языке/u],
    [valid.replace("до релиза.\n", "до релиза.\nЛишний абзац.\n"), /ровно 4 строк полей/u],
    [valid.replace("## F3 · High", "### Вложенный заголовок\n\n## F3 · High"), /неожиданный заголовок/u],
    [valid.replace("Файл ведёт оркестратор.", "<!-- комментарий -->"), /неожиданная строка перед решениями/u],
  ];
  for (const [source, message] of cases) {
    assert.throws(
      () => parseFindingDecisions("review", source),
      (error) => error instanceof FindingDecisionsError && message.test(error.message),
      String(message),
    );
  }
});

test("выбор работы исполняет решения по порядку отчёта и собирает раунд решений без них", () => {
  const findings = [
    { id: "F1", heading: "F1 · High — Проблема F1" },
    { id: "F3", heading: "F3 · High — Проблема F3" },
    { id: "F4", heading: "F4 · High — Проблема F4" },
  ];
  assert.deepEqual(selectFindingWork([], records), { kind: "no-findings" });
  assert.deepEqual(selectFindingWork(findings, records), { kind: "resolution", record: records[0] });
  assert.deepEqual(
    selectFindingWork(findings.slice(1), records),
    { kind: "resolution", record: records[1] },
  );
  // Решение с препятствием не исполняется, а переформулированная finding
  // больше не связана со старым решением.
  const remaining = [findings[2], { id: "F3", heading: "F3 · High — Новая формулировка" }];
  assert.deepEqual(selectFindingWork(remaining, records), { kind: "decisions", findings: remaining });
});

test("решения сессии покрывают ровно её findings и получают заголовки из отчёта", () => {
  const findings = [
    { id: "F1", heading: "F1 · High — Проблема F1" },
    { id: "F3", heading: "F3 · High — Проблема F3" },
  ];
  const bound = bindFindingDecisions(findings, {
    decisions: [
      { findingId: "F3", ...acceptRisk },
      { findingId: "F1", ...remediate },
    ],
  });
  assert.deepEqual(bound, [record("F1", remediate), record("F3", acceptRisk)]);
  assert.equal(summarizeFindingDecisions(bound), "устранить: F1; принять риск: F3");

  assert.throws(
    () => bindFindingDecisions(findings, { decisions: [{ findingId: "F1", ...remediate }] }),
    /Нет решения пользователя по findings: F3/u,
  );
  assert.throws(
    () => bindFindingDecisions(findings, {
      decisions: [
        { findingId: "F1", ...remediate },
        { findingId: "F1", ...remediate },
        { findingId: "F3", ...acceptRisk },
      ],
    }),
    /передано больше одного раза/u,
  );
  assert.throws(
    () => bindFindingDecisions(findings, {
      decisions: [
        { findingId: "F1", ...remediate },
        { findingId: "F3", ...acceptRisk },
        { findingId: "F7", ...remediate },
      ],
    }),
    /вне этой сессии: F7/u,
  );
  assert.throws(
    () => bindFindingDecisions([{ id: "F1", heading: "F1 первая\nвторая" }], {
      decisions: [{ findingId: "F1", ...remediate }],
    }),
    /нельзя записать в файл решений/u,
  );
});

test("исполнение меняет только запись своей finding и убирает решения закрытых findings", () => {
  const active = (...ids) => ids.map((id) => ({ id, heading: `${id} · High — Проблема ${id}` }));
  assert.deepEqual(decisionsAfterResolution(records, "F3", active("F1", "F4")), [records[0], records[2]]);
  // Finding F1, закрытая попутно, теряет своё решение вместе с F3.
  assert.deepEqual(decisionsAfterResolution(records, "F3", active("F4")), [records[2]]);

  const blocked = withBlockedFindingDecision(records, "F1", "Нужно согласовать миграцию данных.");
  assert.deepEqual(blocked[0], record("F1", { kind: "blocked", reason: "Нужно согласовать миграцию данных." }));
  assert.deepEqual(blocked.slice(1), records.slice(1));
  assert.deepEqual(
    decisionsAfterBlock(records, "F1", "Нужно согласовать миграцию данных.", active("F1", "F4")),
    [blocked[0], blocked[2]],
  );
  assert.equal(sameFindingDecisions(records, [...records]), true);
  assert.equal(sameFindingDecisions(records, [records[1], records[0], records[2]]), false);
  assert.equal(sameFindingDecisions(records, blocked), false);
});

test("изменение решений открытых findings после начала сессии обнаруживается", () => {
  const active = (...ids) => ids.map((id) => ({ id, heading: `${id} · High — Проблема ${id}` }));
  const findings = active("F1", "F3");
  assert.equal(openDecisionsChanged(records, records, "F1", findings), false);
  // Сессия F1 сама удаляет своё решение.
  assert.equal(openDecisionsChanged(records, records.slice(1), "F1", findings), false);
  // Пользователь изменил решение F1 или другой открытой finding.
  const edited = record("F1", { kind: "remediate", instruction: "Другое исправление." });
  assert.equal(openDecisionsChanged(records, [edited, ...records.slice(1)], "F1", findings), true);
  assert.equal(openDecisionsChanged(records, [records[0], records[2]], "F1", findings), true);
  // Пользователь добавил решение по finding без решения.
  assert.equal(
    openDecisionsChanged([records[0]], records, "F1", findings),
    true,
  );
});

test("заголовок finding допускает служебные символы markdown, но не перевод строки", () => {
  assert.equal(findingHeadingSchema.safeParse("F2 · Переход draft --> ready <!-- не описан").success, true);
  assert.equal(findingHeadingSchema.safeParse("F2\tс табуляцией").success, true);
  assert.equal(findingHeadingSchema.safeParse("F2 первая\nвторая").success, false);
  assert.equal(findingHeadingSchema.safeParse(`F2 ${"а".repeat(4_000)}`).success, false);
  assert.equal(findingHeadingSchema.safeParse("Без ID").success, false);
  const source = renderFindingDecisions("review", [
    record("F2", remediate, "F2 · Переход draft --> ready <!-- не описан"),
  ]);
  assert.deepEqual(
    parseFindingDecisions("review", source),
    [record("F2", remediate, "F2 · Переход draft --> ready <!-- не описан")],
  );
  assert.throws(
    () => parseFindingDecisions("review", source.replace("## F2 ·", `## F${"9".repeat(40)} ·`)),
    /некорректный ID в заголовке решения/u,
  );
});
