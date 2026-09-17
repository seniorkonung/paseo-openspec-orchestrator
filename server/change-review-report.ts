import { lstat, readFile, realpath } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";
import { openSpecChangeIdSchema } from "./openspec-change.ts";

export const MAX_CHANGE_REVIEW_BYTES = 1024 * 1024;
export const MAX_CHANGE_REVIEW_FINDINGS = 256;
const PLACEHOLDER = /^(?:<[^<>\n]+>|TODO|TBD|FIXME)$/u;
const CONTROL_CHARACTER = /[\x00-\x08\x0b-\x1f\x7f]/u;
const contractFindingIdSchema = z.string().regex(/^F[1-9][0-9]*$/u);

export const reviewFindingIdSchema = contractFindingIdSchema
  .max(32);

const acceptedRiskIdSchema = z
  .string()
  .regex(/^AR[1-9][0-9]*$/u, "Accepted risk ID должен иметь вид AR<n>");

export type ReviewFindingId = z.infer<typeof reviewFindingIdSchema>;

export type ReviewFindingSeverity = "Critical" | "High" | "Medium" | "Low";

export interface ChangeReviewFinding {
  readonly id: ReviewFindingId;
  readonly severity: ReviewFindingSeverity;
  readonly title: string;
}

export interface ParsedChangeReviewReport {
  readonly changeId: string;
  readonly result: "Changes needed" | "Review incomplete" | "No unresolved findings";
  readonly coverageStatus: "Complete" | "Incomplete";
  readonly findings: readonly ChangeReviewFinding[];
  readonly acceptedRiskIds: readonly string[];
}

export interface ReadChangeReviewReportRequest {
  readonly reviewPath: string;
  readonly changeRoot: string;
  readonly expectedChangeId: string;
  readonly inspectPath?: typeof lstat;
  readonly resolveRealPath?: typeof realpath;
  readonly readBytes?: typeof readFile;
}

interface SourceLine {
  readonly raw: string;
  readonly line: number;
}

interface ParsedFields {
  readonly values: ReadonlyMap<string, string>;
  readonly present: ReadonlySet<string>;
}

interface FieldDefinition {
  readonly label: string;
  readonly optional?: boolean;
  readonly multiline?: boolean;
}

interface ParsedFindingEntry extends ChangeReviewFinding {
  readonly fields: ParsedFields;
}

interface ParsedAcceptedRiskEntry {
  readonly id: string;
  readonly title: string;
  readonly fields: ParsedFields;
}

const ASSESSMENT_FIELDS: readonly FieldDefinition[] = Object.freeze([
  { label: "Format version" },
  { label: "Result" },
  { label: "Coverage status" },
  { label: "Coverage limitations", optional: true, multiline: true },
  { label: "Summary", multiline: true },
  { label: "Validation", multiline: true },
]);

const FINDING_FIELDS: readonly FieldDefinition[] = Object.freeze([
  { label: "Evidence", multiline: true },
  { label: "Impact", multiline: true },
  { label: "Required change", multiline: true },
  { label: "Decision needed", optional: true, multiline: true },
]);

const ACCEPTED_RISK_FIELDS: readonly FieldDefinition[] = Object.freeze([
  { label: "Evidence", multiline: true },
  { label: "Potential impact", multiline: true },
  { label: "Acceptance rationale", multiline: true },
  { label: "Scope and assumptions", multiline: true },
  { label: "Reopen when", multiline: true },
  { label: "Acceptance authority", multiline: true },
  { label: "Originating finding" },
  { label: "Acceptance lifetime" },
  { label: "Decision record", optional: true, multiline: true },
]);

const SECTION_ORDER = Object.freeze([
  "Assessment",
  "Findings",
  "Accepted risks",
  "Review coverage",
] as const);

const EMPTY_COMPLETE_FINDINGS =
  "No unresolved findings remain in the reviewed change artifacts and relevant repository context.";
const EMPTY_INCOMPLETE_FINDINGS = "No findings confirmed; review incomplete.";

export class ChangeReviewReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeReviewReportError";
  }
}

export async function readChangeReviewReport(
  request: ReadChangeReviewReportRequest,
): Promise<ParsedChangeReviewReport> {
  const inspectPath = request.inspectPath ?? lstat;
  const resolveRealPath = request.resolveRealPath ?? realpath;
  const readBytes = request.readBytes ?? readFile;

  let reviewStat;
  try {
    reviewStat = await inspectPath(request.reviewPath);
  } catch {
    throw new ChangeReviewReportError("Не удалось прочитать review.md выбранного change");
  }
  if (!reviewStat.isFile() || reviewStat.isSymbolicLink()) {
    throw new ChangeReviewReportError(
      "review.md должен быть обычным файлом внутри выбранного change",
    );
  }
  if (reviewStat.size <= 0 || reviewStat.size > MAX_CHANGE_REVIEW_BYTES) {
    throw new ChangeReviewReportError(
      `review.md должен иметь размер от 1 байта до ${MAX_CHANGE_REVIEW_BYTES} байт`,
    );
  }

  let resolvedReviewPath: string;
  let bytes: Buffer;
  try {
    [resolvedReviewPath, bytes] = await Promise.all([
      resolveRealPath(request.reviewPath),
      readBytes(request.reviewPath),
    ]);
  } catch {
    throw new ChangeReviewReportError("Не удалось безопасно прочитать review.md");
  }
  if (relative(request.changeRoot, resolvedReviewPath) !== "review.md") {
    throw new ChangeReviewReportError(
      "review.md находится за пределами выбранного OpenSpec change",
    );
  }
  if (bytes.byteLength > MAX_CHANGE_REVIEW_BYTES) {
    throw new ChangeReviewReportError(
      `review.md превышает предел ${MAX_CHANGE_REVIEW_BYTES} байт`,
    );
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ChangeReviewReportError("review.md должен содержать корректный UTF-8");
  }
  return parseChangeReviewReport(source, request.expectedChangeId);
}

export function parseChangeReviewReport(
  source: string,
  expectedChangeId: string,
): ParsedChangeReviewReport {
  const parsedChangeId = openSpecChangeIdSchema.safeParse(expectedChangeId);
  if (!parsedChangeId.success) {
    throw new ChangeReviewReportError("Ожидаемый OpenSpec change ID некорректен");
  }
  const changeId = parsedChangeId.data;
  const lines = normalizeLines(source);
  const nonblank = lines.filter(({ raw }) => raw !== "");
  const title = nonblank.shift();
  const titlePrefix = "# OpenSpec Change Review: ";
  if (!title?.raw.startsWith(titlePrefix)) {
    fail(title?.line ?? 1, `ожидался заголовок «${titlePrefix}<change-name>»`);
  }
  const reportedChangeId = title.raw.slice(titlePrefix.length).trim();
  if (reportedChangeId !== changeId) {
    fail(title.line, `review.md относится к другому change: «${reportedChangeId}»`);
  }

  const sections = splitSections(nonblank);
  const assessment = parseFields(
    requireSection(sections, "Assessment"),
    ASSESSMENT_FIELDS,
    "Assessment",
    "",
  );
  validateAssessmentValues(assessment);

  const coverageStatus = assessment.values.get("Coverage status") as
    | "Complete"
    | "Incomplete";
  const findings = parseFindings(
    requireSection(sections, "Findings"),
    coverageStatus,
  );
  const acceptedRisks = sections.has("Accepted risks")
    ? parseAcceptedRisks(requireSection(sections, "Accepted risks"))
    : [];
  validateReviewCoverage(requireSection(sections, "Review coverage"));
  validateAssessmentConsistency(assessment, findings, acceptedRisks);

  const result = assessment.values.get("Result") as ParsedChangeReviewReport["result"];
  return Object.freeze({
    changeId,
    result,
    coverageStatus,
    findings: Object.freeze(findings.map(({ id, severity, title }) =>
      Object.freeze({ id, severity, title }),
    )),
    acceptedRiskIds: Object.freeze(acceptedRisks.map(({ id }) => id)),
  });
}

function normalizeLines(source: string): SourceLine[] {
  if (typeof source !== "string") {
    throw new ChangeReviewReportError("review.md должен содержать Markdown-текст");
  }
  return source
    .replace(/^\uFEFF/u, "")
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((raw, index) => {
      if (CONTROL_CHARACTER.test(raw)) {
        fail(index + 1, "управляющие символы запрещены");
      }
      if (raw.includes("<!--") || raw.includes("-->")) {
        fail(index + 1, "HTML-комментарии запрещены");
      }
      return { raw: raw.trimEnd(), line: index + 1 };
    });
}

function splitSections(lines: readonly SourceLine[]): Map<string, SourceLine[]> {
  const sections = new Map<string, SourceLine[]>();
  let current: SourceLine[] | null = null;
  let lastIndex = -1;
  for (const line of lines) {
    const heading = /^## (.+)$/u.exec(line.raw);
    if (heading) {
      const name = heading[1] ?? "";
      const index = SECTION_ORDER.indexOf(name as (typeof SECTION_ORDER)[number]);
      if (index < 0) fail(line.line, `неизвестный раздел «${name}»`);
      if (sections.has(name)) fail(line.line, `раздел «${name}» повторяется`);
      if (index < lastIndex) fail(line.line, `раздел «${name}» находится не по порядку`);
      lastIndex = index;
      current = [];
      sections.set(name, current);
      continue;
    }
    if (!current) fail(line.line, "содержимое вне известного раздела");
    current.push(line);
  }
  return sections;
}

function requireSection(
  sections: ReadonlyMap<string, SourceLine[]>,
  name: string,
): readonly SourceLine[] {
  const section = sections.get(name);
  if (!section) throw new ChangeReviewReportError(`review.md не содержит раздел ${name}`);
  return section;
}

function parseFields(
  lines: readonly SourceLine[],
  definitions: readonly FieldDefinition[],
  section: string,
  prefix: "" | "- ",
): ParsedFields {
  const values = new Map<string, string>();
  let current: { definition: FieldDefinition; value: string; line: number } | null = null;
  let lastIndex = -1;

  const commitCurrent = () => {
    if (!current) return;
    validateTextValue(current.value, current.definition.label, current.line);
    values.set(current.definition.label, current.value);
    current = null;
  };

  for (const line of lines) {
    const match = /^(- )?\*\*([^*]+):\*\*(?: ([^\n]*))?$/u.exec(line.raw);
    if (match && (match[1] ?? "") === prefix) {
      commitCurrent();
      const label = match[2] ?? "";
      const index = definitions.findIndex((definition) => definition.label === label);
      if (index < 0) fail(line.line, `неизвестное поле «${label}» в ${section}`);
      if (index < lastIndex) fail(line.line, `поле «${label}» находится не по порядку`);
      if (values.has(label)) fail(line.line, `поле «${label}» повторяется`);
      lastIndex = index;
      current = {
        definition: definitions[index]!,
        value: match[3] ?? "",
        line: line.line,
      };
      continue;
    }
    if (
      current?.definition.multiline &&
      line.raw.startsWith("  ") &&
      !/^(?:[-*+] |\d+[.)] |[#>|`~]|\*\*|<!)|\*\*[^*]+:\*\*/u.test(
        line.raw.trimStart(),
      )
    ) {
      current.value += `\n${line.raw.slice(2)}`;
      continue;
    }
    fail(line.line, `некорректная строка поля в ${section}`);
  }
  commitCurrent();

  for (const definition of definitions) {
    if (!definition.optional && !values.has(definition.label)) {
      throw new ChangeReviewReportError(
        `review.md не содержит обязательное поле ${definition.label} в ${section}`,
      );
    }
  }
  return { values, present: new Set(values.keys()) };
}

function validateTextValue(value: string, label: string, line: number): void {
  if (!value.trim()) fail(line, `поле «${label}» не должно быть пустым`);
  if (PLACEHOLDER.test(value)) fail(line, `поле «${label}» содержит placeholder`);
}

function validateAssessmentValues(assessment: ParsedFields): void {
  const version = assessment.values.get("Format version");
  if (version !== "1") {
    throw new ChangeReviewReportError("Поддерживается только Format version: 1");
  }
  const result = assessment.values.get("Result");
  if (![
    "Changes needed",
    "Review incomplete",
    "No unresolved findings",
  ].includes(result ?? "")) {
    throw new ChangeReviewReportError("Поле Result содержит неизвестное значение");
  }
  const coverage = assessment.values.get("Coverage status");
  if (coverage !== "Complete" && coverage !== "Incomplete") {
    throw new ChangeReviewReportError("Поле Coverage status содержит неизвестное значение");
  }
  const limitations = assessment.present.has("Coverage limitations");
  if (coverage === "Incomplete" && !limitations) {
    throw new ChangeReviewReportError(
      "Incomplete review требует поле Coverage limitations",
    );
  }
  if (coverage === "Complete" && limitations) {
    throw new ChangeReviewReportError(
      "Complete review не должен содержать Coverage limitations",
    );
  }
}

function parseFindings(
  lines: readonly SourceLine[],
  coverageStatus: "Complete" | "Incomplete",
): ParsedFindingEntry[] {
  const empty = coverageStatus === "Incomplete"
    ? EMPTY_INCOMPLETE_FINDINGS
    : EMPTY_COMPLETE_FINDINGS;
  if (lines.length === 1 && lines[0]?.raw === empty) return [];
  const records: ParsedFindingEntry[] = [];
  const ids = new Set<string>();
  let current: { id: ReviewFindingId; severity: ReviewFindingSeverity; title: string; body: SourceLine[] } | null = null;

  const commitCurrent = () => {
    if (!current) return;
    const fields = parseFields(current.body, FINDING_FIELDS, current.id, "- ");
    records.push({ ...current, fields });
    current = null;
  };

  for (const line of lines) {
    const match = /^### (F[1-9][0-9]*) · (Critical|High|Medium|Low) — (\S.*)$/u.exec(line.raw);
    if (match) {
      commitCurrent();
      const parsedId = reviewFindingIdSchema.safeParse(match[1]);
      if (!parsedId.success) fail(line.line, "Finding ID слишком длинный");
      const id = parsedId.data;
      if (ids.has(id)) fail(line.line, `Finding ${id} повторяется`);
      if (records.length >= MAX_CHANGE_REVIEW_FINDINGS) {
        fail(line.line, `review.md содержит больше ${MAX_CHANGE_REVIEW_FINDINGS} findings`);
      }
      const title = match[3] ?? "";
      if (PLACEHOLDER.test(title)) fail(line.line, `Finding ${id} содержит placeholder`);
      ids.add(id);
      current = {
        id,
        severity: match[2] as ReviewFindingSeverity,
        title,
        body: [],
      };
      continue;
    }
    if (!current || line.raw.startsWith("#")) {
      fail(line.line, `ожидалась каноническая запись F<n> или строка «${empty}»`);
    }
    current.body.push(line);
  }
  commitCurrent();
  if (records.length === 0) {
    throw new ChangeReviewReportError("Раздел Findings не содержит findings");
  }
  return records;
}

function parseAcceptedRisks(lines: readonly SourceLine[]): ParsedAcceptedRiskEntry[] {
  const records: ParsedAcceptedRiskEntry[] = [];
  const ids = new Set<string>();
  let current: { id: string; title: string; body: SourceLine[] } | null = null;

  const commitCurrent = () => {
    if (!current) return;
    const fields = parseFields(current.body, ACCEPTED_RISK_FIELDS, current.id, "- ");
    records.push({ ...current, fields });
    current = null;
  };

  for (const line of lines) {
    const match = /^### (AR[1-9][0-9]*) · (\S.*)$/u.exec(line.raw);
    if (match) {
      commitCurrent();
      const id = acceptedRiskIdSchema.parse(match[1]);
      if (ids.has(id)) fail(line.line, `Accepted risk ${id} повторяется`);
      const title = match[2] ?? "";
      if (PLACEHOLDER.test(title)) fail(line.line, `Accepted risk ${id} содержит placeholder`);
      ids.add(id);
      current = { id, title, body: [] };
      continue;
    }
    if (!current || line.raw.startsWith("#")) {
      fail(line.line, "ожидалась каноническая запись AR<n>");
    }
    current.body.push(line);
  }
  commitCurrent();
  if (records.length === 0) {
    throw new ChangeReviewReportError("Пустой раздел Accepted risks нужно удалить");
  }
  return records;
}

function validateReviewCoverage(lines: readonly SourceLine[]): void {
  if (lines.length === 0) {
    throw new ChangeReviewReportError("Раздел Review coverage не должен быть пустым");
  }
  for (const line of lines) {
    if (/^\s*(?:[#>|`~]|[-*+] |\d+[.)] |<!)|\*\*[^*]+:\*\*/u.test(line.raw)) {
      fail(line.line, "Review coverage должен содержать только prose");
    }
    if (PLACEHOLDER.test(line.raw)) fail(line.line, "Review coverage содержит placeholder");
  }
}

function validateAssessmentConsistency(
  assessment: ParsedFields,
  findings: readonly ParsedFindingEntry[],
  acceptedRisks: readonly ParsedAcceptedRiskEntry[],
): void {
  const coverage = assessment.values.get("Coverage status");
  const expectedResult = findings.length > 0
    ? "Changes needed"
    : coverage === "Incomplete"
      ? "Review incomplete"
      : "No unresolved findings";
  if (assessment.values.get("Result") !== expectedResult) {
    throw new ChangeReviewReportError(
      `Поле Result должно иметь значение «${expectedResult}»`,
    );
  }

  const activeIds = new Set(findings.map(({ id }) => id));
  const riskIds = new Set(acceptedRisks.map(({ id }) => id));
  const originatingFindingIds = new Set<string>();
  const summary = assessment.values.get("Summary") ?? "";
  for (const risk of acceptedRisks) {
    const origin = risk.fields.values.get("Originating finding") ?? "";
    const parsedOrigin = contractFindingIdSchema.safeParse(origin);
    if (
      !parsedOrigin.success ||
      activeIds.has(parsedOrigin.data) ||
      originatingFindingIds.has(parsedOrigin.data)
    ) {
      throw new ChangeReviewReportError(
        `Accepted risk ${risk.id} содержит некорректный Originating finding`,
      );
    }
    originatingFindingIds.add(parsedOrigin.data);
    const lifetime = risk.fields.values.get("Acceptance lifetime");
    if (lifetime !== "Change-scoped" && lifetime !== "Durable") {
      throw new ChangeReviewReportError(
        `Accepted risk ${risk.id} содержит неизвестный Acceptance lifetime`,
      );
    }
    if (lifetime === "Durable" && !risk.fields.present.has("Decision record")) {
      throw new ChangeReviewReportError(
        `Accepted risk ${risk.id} с Durable lifetime требует Decision record`,
      );
    }
    if (!new RegExp(`\\b${risk.id}\\b`, "u").test(summary)) {
      throw new ChangeReviewReportError(`Summary должен упоминать ${risk.id}`);
    }
  }
  for (const reference of summary.match(/\bAR[1-9][0-9]*\b/gu) ?? []) {
    if (!riskIds.has(reference)) {
      throw new ChangeReviewReportError(`Summary ссылается на отсутствующий ${reference}`);
    }
  }
}

function fail(line: number, message: string): never {
  throw new ChangeReviewReportError(`Некорректный review.md, строка ${line}: ${message}`);
}
