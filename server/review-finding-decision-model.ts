import { z } from "zod";
import {
  MAX_CHANGE_REVIEW_FINDINGS,
  reviewFindingIdSchema,
  type ReviewFindingId,
} from "./change-review-report.ts";
import type { ReviewFindingPublicationKind } from "./review-finding-publication.ts";

/**
 * Файл решений пользователя по findings одного отчёта ревью.
 *
 * Решения по всем открытым findings принимаются в одной интерактивной сессии,
 * а исполняются потом автономно, по одной finding за сессию. Файл лежит рядом
 * с отчётом и содержит решения только по ещё открытым findings: сессия
 * исполнения удаляет раздел своей finding в том же коммите, что и её
 * устранение. Форматом владеет оркестратор: он сам генерирует файл из
 * проверенных данных и строго разбирает его при чтении.
 */

export const MAX_FINDING_DECISIONS_BYTES = 256 * 1024;
export const MAX_FINDING_DECISION_TEXT_LENGTH = 2_000;
export const MAX_FINDING_HEADING_LENGTH = 4_000;

const FORMAT_MARKER = "<!-- paseo-openspec-orchestrator:finding-decisions:v1 -->";
const PREAMBLE =
  "Файл ведёт оркестратор. Решения приняты пользователем в сессии решений и исполняются автономно, по одной finding за сессию. Сессия исполнения удаляет раздел своей finding в коммите её устранения.";
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** Заголовок отчёта может содержать табуляцию, но не перевод строки. */
const HEADING_BREAKING_CHARACTER = /(?!\t)[\p{Cc}\p{Zl}\p{Zp}]/u;
const RUSSIAN_CHARACTER = /[А-Яа-яЁё]/u;
const FINDING_HEADING_ID = /^(F[1-9][0-9]*)\b/u;

const DECISION_FILE_NAMES: Record<ReviewFindingPublicationKind, string> = {
  review: "review-decisions.md",
  "implementation-review": "implementation-review-decisions.md",
};

const DECISION_FILE_TITLES: Record<ReviewFindingPublicationKind, string> = {
  review: "# Решения по findings OpenSpec review",
  "implementation-review": "# Решения по findings OpenSpec implementation review",
};

export class FindingDecisionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingDecisionsError";
  }
}

export function findingDecisionsFileName(kind: ReviewFindingPublicationKind): string {
  return DECISION_FILE_NAMES[kind];
}

/** Однострочный русский текст решения без служебных маркеров. */
export const findingDecisionTextSchema = z
  .string()
  .max(MAX_FINDING_DECISION_TEXT_LENGTH)
  .refine(
    (value) => !CONTROL_CHARACTER.test(value),
    "Текст решения должен занимать одну строку без управляющих символов",
  )
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(MAX_FINDING_DECISION_TEXT_LENGTH))
  .refine(
    (value) => RUSSIAN_CHARACTER.test(value),
    "Текст решения должен быть на русском языке",
  )
  .refine(
    (value) => !value.includes("<!--") && !value.includes("-->"),
    "Текст решения содержит служебный marker",
  );

/** Заголовок finding из отчёта: решение действует, только пока он не изменился. */
export const findingHeadingSchema = z
  .string()
  .min(1)
  .max(MAX_FINDING_HEADING_LENGTH, `Заголовок finding длиннее ${MAX_FINDING_HEADING_LENGTH} символов`)
  .refine(
    (value) => !HEADING_BREAKING_CHARACTER.test(value) && value === value.trim(),
    "Заголовок finding должен занимать одну строку без управляющих символов",
  )
  .refine(
    (value) => FINDING_HEADING_ID.test(value),
    "Заголовок finding должен начинаться с её ID",
  );

const remediateShape = {
  kind: z.literal("remediate"),
  /** Самодостаточное описание согласованного исправления. */
  instruction: findingDecisionTextSchema,
};

const acceptRiskShape = {
  kind: z.literal("accept-risk"),
  rationale: findingDecisionTextSchema,
  scope: findingDecisionTextSchema,
  reopenWhen: findingDecisionTextSchema,
};

/** Решение пользователя, которое исполняет автономная сессия. */
export const findingDecisionSchema = z.discriminatedUnion("kind", [
  z.object(remediateShape).strict(),
  z.object(acceptRiskShape).strict(),
]);

export type FindingDecision = z.output<typeof findingDecisionSchema>;

/**
 * Решение, которое сессия исполнения не смогла выполнить как согласовано.
 * Его записывает оркестратор, и finding попадает в следующий раунд решений.
 */
export type BlockedFindingDecision = {
  readonly kind: "blocked";
  readonly reason: string;
};

export type FindingDecisionEntry = FindingDecision | BlockedFindingDecision;

export interface FindingDecisionRecord<
  Decision extends FindingDecisionEntry = FindingDecisionEntry,
> {
  readonly findingId: ReviewFindingId;
  readonly heading: string;
  readonly decision: Decision;
}

export type ExecutableFindingDecisionRecord = FindingDecisionRecord<FindingDecision>;

/** Вход MCP-инструмента сессии решений. */
export const findingDecisionsInputSchema = z
  .object({
    decisions: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ findingId: reviewFindingIdSchema, ...remediateShape }).strict(),
          z.object({ findingId: reviewFindingIdSchema, ...acceptRiskShape }).strict(),
        ]),
      )
      .min(1)
      .max(MAX_CHANGE_REVIEW_FINDINGS),
  })
  .strict();

export type FindingDecisionsInput = z.output<typeof findingDecisionsInputSchema>;

/** Открытая finding отчёта, как её видит выбор следующей работы. */
export interface ActiveFinding {
  readonly id: ReviewFindingId;
  readonly heading: string;
}

/**
 * Следующая работа по findings отчёта.
 *
 * Сначала исполняются уже принятые решения в порядке отчёта. Сессия решений
 * нужна, только когда ни у одной открытой finding решения нет: так новые
 * findings и findings с препятствием собираются в один следующий раунд.
 */
export type FindingWorkSelection =
  | { readonly kind: "no-findings" }
  | { readonly kind: "resolution"; readonly record: ExecutableFindingDecisionRecord }
  | { readonly kind: "decisions"; readonly findings: readonly ActiveFinding[] };

export function selectFindingWork(
  findings: readonly ActiveFinding[],
  records: readonly FindingDecisionRecord[],
): FindingWorkSelection {
  if (findings.length === 0) return { kind: "no-findings" };
  for (const finding of findings) {
    const record = executableDecisionFor(records, finding);
    if (record) return { kind: "resolution", record };
  }
  return { kind: "decisions", findings };
}

/** Решение, которое можно исполнить без пользователя. */
export function executableDecisionFor(
  records: readonly FindingDecisionRecord[],
  finding: ActiveFinding,
): ExecutableFindingDecisionRecord | null {
  const record = decisionFor(records, finding);
  return record && isExecutable(record) ? record : null;
}

function isExecutable(record: FindingDecisionRecord): record is ExecutableFindingDecisionRecord {
  return record.decision.kind !== "blocked";
}

/**
 * Решение, действующее для finding. Решение привязано и к ID, и к заголовку:
 * повторный аудит может переиспользовать ID для другой проблемы, и старое
 * решение не должно к ней применяться.
 */
export function decisionFor(
  records: readonly FindingDecisionRecord[],
  finding: ActiveFinding,
): FindingDecisionRecord | null {
  return (
    records.find(
      ({ findingId, heading }) => findingId === finding.id && heading === finding.heading,
    ) ?? null
  );
}

/**
 * Проверяет, что решения покрывают ровно выбранные findings, и связывает их с
 * заголовками отчёта.
 */
export function bindFindingDecisions(
  findings: readonly ActiveFinding[],
  input: FindingDecisionsInput,
): readonly ExecutableFindingDecisionRecord[] {
  const byId = new Map<ReviewFindingId, FindingDecisionsInput["decisions"][number]>();
  for (const decision of input.decisions) {
    if (byId.has(decision.findingId)) {
      throw new FindingDecisionsError(
        `Решение по finding «${decision.findingId}» передано больше одного раза`,
      );
    }
    byId.set(decision.findingId, decision);
  }
  const expected = new Set(findings.map(({ id }) => id));
  const unexpected = [...byId.keys()].filter((id) => !expected.has(id));
  if (unexpected.length > 0) {
    throw new FindingDecisionsError(
      `Решения переданы для findings вне этой сессии: ${unexpected.join(", ")}`,
    );
  }
  const missing = findings.filter(({ id }) => !byId.has(id)).map(({ id }) => id);
  if (missing.length > 0) {
    throw new FindingDecisionsError(
      `Нет решения пользователя по findings: ${missing.join(", ")}`,
    );
  }
  return findings.map((finding) => {
    const { findingId, ...decision } = byId.get(finding.id)!;
    const heading = findingHeadingSchema.safeParse(finding.heading);
    if (!heading.success) {
      throw new FindingDecisionsError(
        `Заголовок finding «${finding.id}» нельзя записать в файл решений: ${heading.error.issues[0]?.message ?? "некорректный заголовок"}`,
      );
    }
    return Object.freeze({
      findingId,
      heading: heading.data,
      decision: findingDecisionSchema.parse(decision),
    });
  });
}

/** Краткая сводка решений для истории workflow. */
export function summarizeFindingDecisions(
  records: readonly ExecutableFindingDecisionRecord[],
): string {
  const ids = (kind: FindingDecision["kind"]): string =>
    records.filter(({ decision }) => decision.kind === kind).map(({ findingId }) => findingId).join(", ");
  return [
    ["устранить", ids("remediate")],
    ["принять риск", ids("accept-risk")],
  ]
    .filter(([, list]) => list !== "")
    .map(([label, list]) => `${label}: ${list}`)
    .join("; ");
}

/** Решения после того, как исполнение finding упёрлось в препятствие. */
export function withBlockedFindingDecision(
  records: readonly FindingDecisionRecord[],
  findingId: ReviewFindingId,
  reason: string,
): readonly FindingDecisionRecord[] {
  const blocked: BlockedFindingDecision = {
    kind: "blocked",
    reason: findingDecisionTextSchema.parse(reason),
  };
  return records.map((record) =>
    record.findingId === findingId ? Object.freeze({ ...record, decision: blocked }) : record,
  );
}

/**
 * Файл решений, который должен получиться после закрытия finding: без её
 * раздела и без разделов findings, которых больше нет в отчёте. Так в файле
 * не остаётся решений, которые могли бы исполниться для другой finding с тем
 * же ID и заголовком в будущем раунде.
 */
export function decisionsAfterResolution(
  baseline: readonly FindingDecisionRecord[],
  findingId: ReviewFindingId,
  activeFindings: readonly ActiveFinding[],
): readonly FindingDecisionRecord[] {
  return baseline.filter(
    (record) => record.findingId !== findingId && isActiveRecord(record, activeFindings),
  );
}

/** Файл решений после записи препятствия: открытые решения не меняются. */
export function decisionsAfterBlock(
  baseline: readonly FindingDecisionRecord[],
  findingId: ReviewFindingId,
  reason: string,
  activeFindings: readonly ActiveFinding[],
): readonly FindingDecisionRecord[] {
  return withBlockedFindingDecision(baseline, findingId, reason).filter(
    (record) => record.findingId === findingId || isActiveRecord(record, activeFindings),
  );
}

/**
 * Изменились ли решения открытых findings по сравнению с baseline. Удалённое
 * решение по самой finding сессии изменением не считается: его удаляет сессия.
 */
export function openDecisionsChanged(
  baseline: readonly FindingDecisionRecord[],
  head: readonly FindingDecisionRecord[],
  findingId: ReviewFindingId,
  activeFindings: readonly ActiveFinding[],
): boolean {
  return activeFindings.some((finding) => {
    const before = decisionFor(baseline, finding);
    const after = decisionFor(head, finding);
    if (finding.id === findingId && after === null) return false;
    if (before === null || after === null) return before !== after;
    return !sameFindingDecisions([before], [after]);
  });
}

function isActiveRecord(
  record: FindingDecisionRecord,
  activeFindings: readonly ActiveFinding[],
): boolean {
  return activeFindings.some(
    ({ id, heading }) => id === record.findingId && heading === record.heading,
  );
}

export function sameFindingDecisions(
  left: readonly FindingDecisionRecord[],
  right: readonly FindingDecisionRecord[],
): boolean {
  return renderSections(left) === renderSections(right);
}

export function renderFindingDecisions(
  kind: ReviewFindingPublicationKind,
  records: readonly FindingDecisionRecord[],
): string {
  const sections = renderSections(records);
  return `${DECISION_FILE_TITLES[kind]}\n\n${FORMAT_MARKER}\n\n${PREAMBLE}\n${sections.length > 0 ? `\n${sections}` : ""}`;
}

function renderSections(records: readonly FindingDecisionRecord[]): string {
  return records.map(renderSection).join("\n");
}

function renderSection(record: FindingDecisionRecord): string {
  const fields = decisionFields(record.decision)
    .map(([label, value]) => `- **${label}:** ${value}`)
    .join("\n");
  return `## ${record.heading}\n\n${fields}\n`;
}

const DECISION_FIELD = "Решение";

/** Подпись и поля каждого вида записи в порядке файла. */
const DECISION_LAYOUTS = {
  remediate: {
    label: "Устранить",
    fields: [["instruction", "Как устранить"]],
  },
  "accept-risk": {
    label: "Принять остаточный риск",
    fields: [
      ["rationale", "Обоснование"],
      ["scope", "Границы и допущения"],
      ["reopenWhen", "Пересмотреть, если"],
    ],
  },
  blocked: {
    label: "Нужно новое решение",
    fields: [["reason", "Препятствие"]],
  },
} as const satisfies {
  readonly [Kind in FindingDecisionEntry["kind"]]: {
    readonly label: string;
    readonly fields: readonly (readonly [
      Exclude<keyof Extract<FindingDecisionEntry, { kind: Kind }>, "kind">,
      string,
    ])[];
  };
};

type DecisionKind = keyof typeof DECISION_LAYOUTS;

function decisionFields(decision: FindingDecisionEntry): readonly (readonly [string, string])[] {
  const layout = DECISION_LAYOUTS[decision.kind];
  const values: Readonly<Record<string, string>> = decision;
  return [
    [DECISION_FIELD, layout.label],
    ...layout.fields.map(([key, label]) => [label, values[key] ?? ""] as const),
  ];
}

/**
 * Строго разбирает файл решений. Любое отклонение от формата — ошибка с
 * объяснением: файл может отредактировать пользователь, и молча пропущенное
 * решение исполнилось бы не так, как он ожидает.
 */
export function parseFindingDecisions(
  kind: ReviewFindingPublicationKind,
  source: string,
): readonly FindingDecisionRecord[] {
  const fileName = findingDecisionsFileName(kind);
  const fail: (detail: string) => never = (detail) => {
    throw new FindingDecisionsError(`${fileName}: ${detail}`);
  };
  const lines = source.replace(/^﻿/u, "").replace(/\r\n?/gu, "\n").split("\n");
  if (lines[0] !== DECISION_FILE_TITLES[kind]) {
    fail(`первая строка должна быть «${DECISION_FILE_TITLES[kind]}»`);
  }

  let index = 1;
  let markerSeen = false;
  for (; index < lines.length && !lines[index]!.startsWith("## "); index += 1) {
    const line = lines[index]!;
    if (line === FORMAT_MARKER) {
      if (markerSeen) fail("служебный marker формата повторяется");
      markerSeen = true;
    } else if (line.startsWith("#") || line.includes("<!--")) {
      fail(`неожиданная строка перед решениями: «${line}»`);
    }
  }
  if (!markerSeen) fail("нет служебного marker формата");

  const records: FindingDecisionRecord[] = [];
  const findingIds = new Set<ReviewFindingId>();
  while (index < lines.length) {
    const headingLine = lines[index]!;
    const heading = findingHeadingSchema.safeParse(headingLine.slice("## ".length));
    if (!heading.success) return fail(`некорректный заголовок решения «${headingLine}»`);
    const parsedId = reviewFindingIdSchema.safeParse(FINDING_HEADING_ID.exec(heading.data)?.[1]);
    if (!parsedId.success) return fail(`некорректный ID в заголовке решения «${headingLine}»`);
    const findingId = parsedId.data;
    if (findingIds.has(findingId)) fail(`решение по ${findingId} повторяется`);
    findingIds.add(findingId);
    if (records.length >= MAX_CHANGE_REVIEW_FINDINGS) fail("слишком много решений");

    index += 1;
    const fieldLines: string[] = [];
    for (; index < lines.length && !lines[index]!.startsWith("## "); index += 1) {
      const line = lines[index]!;
      if (line.trim() === "") continue;
      if (line.startsWith("#")) fail(`неожиданный заголовок «${line}» в решении ${findingId}`);
      fieldLines.push(line);
    }
    records.push(
      Object.freeze({
        findingId,
        heading: heading.data,
        decision: parseDecisionFields(findingId, fieldLines, fail),
      }),
    );
  }
  return Object.freeze(records);
}

function parseDecisionFields(
  findingId: ReviewFindingId,
  lines: readonly string[],
  fail: (detail: string) => never,
): FindingDecisionEntry {
  const read = (position: number, label: string): string => {
    const prefix = `- **${label}:** `;
    const line = lines[position];
    if (line === undefined || !line.startsWith(prefix)) {
      return fail(`в решении ${findingId} строка ${position + 1} должна начинаться с «${prefix.trim()}»`);
    }
    return line.slice(prefix.length);
  };
  const label = read(0, DECISION_FIELD);
  const kind = (Object.keys(DECISION_LAYOUTS) as DecisionKind[]).find(
    (candidate) => DECISION_LAYOUTS[candidate].label === label,
  );
  if (kind === undefined) {
    return fail(
      `в решении ${findingId} поле «${DECISION_FIELD}» должно быть одним из: ${Object.values(DECISION_LAYOUTS).map((layout) => `«${layout.label}»`).join(", ")}`,
    );
  }
  const fields: readonly (readonly [string, string])[] = DECISION_LAYOUTS[kind].fields;
  if (lines.length !== fields.length + 1) {
    return fail(`в решении ${findingId} должно быть ровно ${fields.length + 1} строк полей`);
  }
  const candidate = Object.fromEntries([
    ["kind", kind],
    ...fields.map(([key, fieldLabel], offset) => [key, read(offset + 1, fieldLabel)]),
  ]);
  const parsed = findingDecisionEntrySchema.safeParse(candidate);
  if (!parsed.success) {
    return fail(
      `решение ${findingId} некорректно: ${parsed.error.issues[0]?.message ?? "неизвестная ошибка"}`,
    );
  }
  return parsed.data;
}

const findingDecisionEntrySchema = z.discriminatedUnion("kind", [
  z.object(remediateShape).strict(),
  z.object(acceptRiskShape).strict(),
  z.object({ kind: z.literal("blocked"), reason: findingDecisionTextSchema }).strict(),
]);
