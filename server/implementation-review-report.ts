import { lstat, readFile, realpath } from "node:fs/promises";
import { relative } from "node:path";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  reviewFindingIdSchema,
  type ReviewFindingId,
  type ReviewFindingSeverity,
} from "./change-review-report.ts";

export const MAX_IMPLEMENTATION_REVIEW_BYTES = 1024 * 1024;
export const MAX_IMPLEMENTATION_REVIEW_FINDINGS = 256;

const PLACEHOLDER = /^(?:<[^<>\n]+>|TODO|TBD|FIXME)$/u;
const CONTROL_CHARACTER = /[\x00-\x08\x0b-\x1f\x7f]/u;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const CONTRACT_FINDING_ID = /^F[1-9][0-9]*$/u;
const ACCEPTED_RISK_ID = /^AR[1-9][0-9]*$/u;

type CoverageStatus = "Complete" | "Incomplete";
type ImplementationReviewResult =
  | "Changes needed"
  | "Incomplete"
  | "No unresolved findings";

export interface ParsedImplementationReviewReport {
  readonly changeId: string;
  readonly result: ImplementationReviewResult;
  readonly coverageStatus: CoverageStatus;
  readonly findings: readonly ImplementationReviewFinding[];
  readonly acceptedRiskIds: readonly string[];
}

export interface ImplementationReviewFinding {
  readonly id: ReviewFindingId;
  readonly severity: ReviewFindingSeverity;
  readonly title: string;
}

export interface ReadImplementationReviewReportRequest {
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

type FieldType =
  | "text"
  | "version"
  | "sha"
  | "shas"
  | "paths"
  | "labels"
  | "strings"
  | "finding-id"
  | readonly string[];

interface FieldDefinition {
  readonly label: string;
  readonly type?: FieldType;
  readonly optional?: boolean;
  readonly multiline?: boolean;
}

interface ParsedFields {
  readonly values: ReadonlyMap<string, unknown>;
  readonly present: ReadonlySet<string>;
}

interface ParsedFindingEntry extends ImplementationReviewFinding {
  readonly fields: ParsedFields;
}

interface ParsedAcceptedRiskEntry {
  readonly id: string;
  readonly title: string;
  readonly fields: ParsedFields;
}

interface ParsedReviewUnit {
  readonly id: string;
  readonly implementationTarget: readonly string[];
}

interface ParsedPass {
  readonly status: CoverageStatus;
}

const ASSESSMENT_FIELDS: readonly FieldDefinition[] = Object.freeze([
  { label: "Format version", type: "version" },
  {
    label: "Result",
    type: ["Changes needed", "Incomplete", "No unresolved findings"],
  },
  { label: "Coverage status", type: ["Complete", "Incomplete"] },
  { label: "Coverage limitations", optional: true, multiline: true },
  { label: "Summary", multiline: true },
]);

const REVIEW_TARGET_FIELDS: readonly FieldDefinition[] = Object.freeze([
  { label: "Baseline ref" },
  { label: "Base commit", type: "sha" },
  { label: "Reviewed head", type: "sha" },
  { label: "Target commits", type: "shas" },
  { label: "Reviewable paths", type: "paths" },
  { label: "OpenSpec change" },
  { label: "OpenSpec schema" },
  {
    label: "Target scope",
    type: ["Complete pre-push range", "User-requested bounded range"],
  },
  { label: "Baseline freshness", type: ["Local ref state; no fetch performed"] },
  { label: "Planning evidence paths", type: "paths", optional: true },
  { label: "Excluded worktree state", type: "paths", optional: true },
]);

const REVIEW_UNIT_FIELDS: readonly FieldDefinition[] = Object.freeze([
  { label: "Work items", type: "labels" },
  { label: "Requirements and scenarios", type: "labels" },
  { label: "Affected boundary", multiline: true },
  { label: "Implementation target", type: "paths" },
  { label: "Applicable constraints and non-goals", multiline: true },
  { label: "Excluded change scope", optional: true, multiline: true },
]);

const UNMAPPED_RANGE_FIELDS: readonly FieldDefinition[] = Object.freeze([
  { label: "Unmatched target paths", type: "paths" },
  { label: "Reason", multiline: true },
]);

const FINDING_FIELDS: readonly FieldDefinition[] = Object.freeze([
  { label: "Evidence", multiline: true },
  { label: "Evidence revisions", type: "shas" },
  { label: "Impact", multiline: true },
  { label: "Required outcome", multiline: true },
  {
    label: "Earliest source of truth",
    type: [
      "implementation/tests",
      "task/verification",
      "design/ADR",
      "requirement/proposal",
      "separate change",
    ],
  },
  { label: "Affected artifacts", type: "strings" },
  { label: "Decision needed", optional: true, multiline: true },
  {
    label: "Current target relation",
    type: ["Carried forward; not re-reviewed"],
    optional: true,
  },
]);

const ACCEPTED_RISK_FIELDS: readonly FieldDefinition[] = Object.freeze([
  { label: "Evidence", multiline: true },
  { label: "Evidence revisions", type: "shas" },
  { label: "Potential impact", multiline: true },
  { label: "Acceptance rationale", multiline: true },
  { label: "Scope and assumptions", multiline: true },
  { label: "Reopen when", multiline: true },
  { label: "Acceptance authority", multiline: true },
  { label: "Originating finding", type: "finding-id" },
  { label: "Acceptance lifetime", type: ["Change-scoped", "Durable"] },
  { label: "Decision record", optional: true, multiline: true },
  {
    label: "Current target relation",
    type: ["Carried forward; not re-reviewed"],
    optional: true,
  },
]);

const SECTION_ORDER = Object.freeze([
  "Assessment",
  "Review target",
  "Reviewed increment",
  "Unmapped range",
  "Pass coverage",
  "Findings",
  "Accepted risks",
  "Review coverage",
] as const);

const EMPTY_COMPLETE_FINDINGS =
  "No unresolved findings remain in the implementation review.";
const EMPTY_INCOMPLETE_FINDINGS = "No findings confirmed; review incomplete.";
const EMPTY_REVIEW_UNITS = "No review units could be established.";

export class ImplementationReviewReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImplementationReviewReportError";
  }
}

export async function readImplementationReviewReport(
  request: ReadImplementationReviewReportRequest,
): Promise<ParsedImplementationReviewReport> {
  const inspectPath = request.inspectPath ?? lstat;
  const resolveRealPath = request.resolveRealPath ?? realpath;
  const readBytes = request.readBytes ?? readFile;

  let reviewStat;
  try {
    reviewStat = await inspectPath(request.reviewPath);
  } catch {
    throw new ImplementationReviewReportError(
      "Не удалось прочитать implementation-review.md выбранного change",
    );
  }
  if (!reviewStat.isFile() || reviewStat.isSymbolicLink()) {
    throw new ImplementationReviewReportError(
      "implementation-review.md должен быть обычным файлом внутри выбранного change",
    );
  }
  if (reviewStat.size <= 0 || reviewStat.size > MAX_IMPLEMENTATION_REVIEW_BYTES) {
    throw new ImplementationReviewReportError(
      `implementation-review.md должен иметь размер от 1 байта до ${MAX_IMPLEMENTATION_REVIEW_BYTES} байт`,
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
    throw new ImplementationReviewReportError(
      "Не удалось безопасно прочитать implementation-review.md",
    );
  }
  if (relative(request.changeRoot, resolvedReviewPath) !== "implementation-review.md") {
    throw new ImplementationReviewReportError(
      "implementation-review.md находится за пределами выбранного OpenSpec change",
    );
  }
  if (bytes.byteLength > MAX_IMPLEMENTATION_REVIEW_BYTES) {
    throw new ImplementationReviewReportError(
      `implementation-review.md превышает предел ${MAX_IMPLEMENTATION_REVIEW_BYTES} байт`,
    );
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ImplementationReviewReportError(
      "implementation-review.md должен содержать корректный UTF-8",
    );
  }
  return parseImplementationReviewReport(source, request.expectedChangeId);
}

export function parseImplementationReviewReport(
  source: string,
  expectedChangeId: string,
): ParsedImplementationReviewReport {
  const parsedChangeId = openSpecChangeIdSchema.safeParse(expectedChangeId);
  if (!parsedChangeId.success) {
    throw new ImplementationReviewReportError("Ожидаемый OpenSpec change ID некорректен");
  }
  const changeId = parsedChangeId.data;
  const lines = normalizeLines(source);
  const nonblank = lines.filter(({ raw }) => raw !== "");
  const title = nonblank.shift();
  const titlePrefix = "# OpenSpec Implementation Review: ";
  if (!title?.raw.startsWith(titlePrefix)) {
    fail(title?.line ?? 1, `ожидался заголовок «${titlePrefix}<change-name>»`);
  }
  const reportedChangeId = title.raw.slice(titlePrefix.length).trim();
  if (reportedChangeId !== changeId) {
    fail(
      title.line,
      `implementation-review.md относится к другому change: «${reportedChangeId}»`,
    );
  }

  const sections = splitSections(nonblank);
  const assessment = parseFields(
    requireSection(sections, "Assessment"),
    ASSESSMENT_FIELDS,
    "Assessment",
    "",
  );
  const coverageStatus = valueAsEnum(
    assessment,
    "Coverage status",
    ["Complete", "Incomplete"] as const,
  );
  const result = valueAsEnum(
    assessment,
    "Result",
    ["Changes needed", "Incomplete", "No unresolved findings"] as const,
  );
  validateAssessment(assessment, coverageStatus);

  const reviewTarget = parseFields(
    requireSection(sections, "Review target"),
    REVIEW_TARGET_FIELDS,
    "Review target",
    "- ",
  );
  const reviewUnits = parseReviewUnits(
    requireSection(sections, "Reviewed increment"),
  );
  const unmappedRange = sections.has("Unmapped range")
    ? parseFields(
        requireSection(sections, "Unmapped range"),
        UNMAPPED_RANGE_FIELDS,
        "Unmapped range",
        "- ",
      )
    : null;
  const passes = parsePassCoverage(requireSection(sections, "Pass coverage"));
  const findings = parseFindings(
    requireSection(sections, "Findings"),
    coverageStatus,
  );
  const acceptedRisks = sections.has("Accepted risks")
    ? parseAcceptedRisks(requireSection(sections, "Accepted risks"))
    : [];
  validateReviewCoverage(requireSection(sections, "Review coverage"));
  validateConsistency({
    changeId,
    result,
    coverageStatus,
    assessment,
    reviewTarget,
    reviewUnits,
    unmappedRange,
    passes,
    findings,
    acceptedRisks,
  });

  return Object.freeze({
    changeId,
    result,
    coverageStatus,
    findings: Object.freeze(
      findings.map(({ id, severity, title }) => Object.freeze({ id, severity, title })),
    ),
    acceptedRiskIds: Object.freeze(acceptedRisks.map(({ id }) => id)),
  });
}

function normalizeLines(source: string): SourceLine[] {
  if (typeof source !== "string") {
    throw new ImplementationReviewReportError(
      "implementation-review.md должен содержать Markdown-текст",
    );
  }
  return source
    .replace(/^\uFEFF/u, "")
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((raw, index) => {
      if (CONTROL_CHARACTER.test(raw)) fail(index + 1, "управляющие символы запрещены");
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
  if (!section) {
    throw new ImplementationReviewReportError(
      `implementation-review.md не содержит раздел ${name}`,
    );
  }
  return section;
}

function parseFields(
  lines: readonly SourceLine[],
  definitions: readonly FieldDefinition[],
  section: string,
  prefix: "" | "- ",
): ParsedFields {
  const values = new Map<string, unknown>();
  let current: {
    definition: FieldDefinition;
    value: string;
    line: number;
  } | null = null;
  let lastIndex = -1;

  const commitCurrent = () => {
    if (!current) return;
    values.set(
      current.definition.label,
      parseFieldValue(current.value, current.definition, current.line),
    );
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
      throw new ImplementationReviewReportError(
        `implementation-review.md не содержит обязательное поле ${definition.label} в ${section}`,
      );
    }
  }
  return { values, present: new Set(values.keys()) };
}

function parseFieldValue(
  raw: string,
  definition: FieldDefinition,
  line: number,
): unknown {
  if (!raw.trim()) fail(line, `поле «${definition.label}» не должно быть пустым`);
  if (PLACEHOLDER.test(raw)) fail(line, `поле «${definition.label}» содержит placeholder`);
  const type = definition.type ?? "text";
  if (type === "text") return raw;
  if (raw.includes("\n")) fail(line, `поле «${definition.label}» должно быть однострочным`);
  if (Array.isArray(type)) {
    if (!type.includes(raw)) {
      fail(line, `поле «${definition.label}» содержит неизвестное значение`);
    }
    return raw;
  }
  if (type === "version") {
    if (raw !== "1") fail(line, "поддерживается только Format version: 1");
    return 1;
  }
  if (type === "sha") {
    if (!SHA.test(raw)) fail(line, `поле «${definition.label}» требует полный commit ID`);
    return raw;
  }
  if (type === "finding-id") {
    if (!CONTRACT_FINDING_ID.test(raw)) {
      fail(line, `поле «${definition.label}» требует F<n>`);
    }
    return raw;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail(line, `поле «${definition.label}» должно быть JSON-массивом строк`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string" || !item.trim()) ||
    (type !== "labels" && parsed.length === 0) ||
    new Set(parsed).size !== parsed.length
  ) {
    fail(line, `поле «${definition.label}» содержит некорректный массив строк`);
  }
  const items = parsed as string[];
  if (items.some((item) => PLACEHOLDER.test(item))) {
    fail(line, `поле «${definition.label}» содержит placeholder`);
  }
  if (type === "shas" && items.some((item) => !SHA.test(item))) {
    fail(line, `поле «${definition.label}» требует полные commit ID`);
  }
  if (
    type === "paths" &&
    items.some(
      (item) =>
        item.includes("\0") ||
        item.startsWith("/") ||
        /^(?:[A-Za-z]:[\\/])/u.test(item) ||
        item.split("/").some((part) => ["", ".", ".."].includes(part)),
    )
  ) {
    fail(line, `поле «${definition.label}» содержит небезопасный путь`);
  }
  return items;
}

function parseReviewUnits(lines: readonly SourceLine[]): ParsedReviewUnit[] {
  if (lines.length === 1 && lines[0]?.raw === EMPTY_REVIEW_UNITS) return [];
  const records: Array<{ id: string; title: string; body: SourceLine[] }> = [];
  const ids = new Set<string>();
  let current: { id: string; title: string; body: SourceLine[] } | null = null;
  for (const line of lines) {
    const match = /^### (U[1-9][0-9]*) · (\S.*)$/u.exec(line.raw);
    if (match) {
      if (current) records.push(current);
      const id = match[1]!;
      const title = match[2]!;
      if (ids.has(id)) fail(line.line, `Review unit ${id} повторяется`);
      if (PLACEHOLDER.test(title)) fail(line.line, `Review unit ${id} содержит placeholder`);
      ids.add(id);
      current = { id, title, body: [] };
      continue;
    }
    if (!current || line.raw.startsWith("#")) {
      fail(line.line, `ожидалась каноническая запись U<n> или «${EMPTY_REVIEW_UNITS}»`);
    }
    current.body.push(line);
  }
  if (current) records.push(current);
  if (records.length === 0) {
    throw new ImplementationReviewReportError(
      "Раздел Reviewed increment не содержит review units",
    );
  }
  return records.map((record) => {
    const fields = parseFields(record.body, REVIEW_UNIT_FIELDS, record.id, "- ");
    return {
      id: record.id,
      implementationTarget: valueAsStringArray(fields, "Implementation target"),
    };
  });
}

function parsePassCoverage(lines: readonly SourceLine[]): ParsedPass[] {
  const names = ["Independent decision review", "OpenSpec conformance", "Code quality"];
  if (
    lines[0]?.raw !== "| Pass | Status | Evidence or limitation |" ||
    !/^\|\s*-{3,}\s*\|\s*-{3,}\s*\|\s*-{3,}\s*\|$/u.test(lines[1]?.raw ?? "") ||
    lines.length !== 5
  ) {
    throw new ImplementationReviewReportError(
      "Pass coverage должен содержать точную таблицу из трёх review passes",
    );
  }
  return lines.slice(2).map((line, index) => {
    const cells = line.raw.split("|");
    if (
      cells.length !== 5 ||
      cells[0] !== "" ||
      cells[4] !== "" ||
      cells[1]?.trim() !== names[index]
    ) {
      fail(line.line, `ожидался review pass «${names[index] ?? "лишняя строка"}»`);
    }
    const status = cells[2]?.trim();
    const evidence = cells[3]?.trim() ?? "";
    if (status !== "Complete" && status !== "Incomplete") {
      fail(line.line, "Status review pass должен быть Complete или Incomplete");
    }
    if (!evidence || PLACEHOLDER.test(evidence)) {
      fail(line.line, "Evidence or limitation review pass не должно быть пустым");
    }
    return { status };
  });
}

function parseFindings(
  lines: readonly SourceLine[],
  coverageStatus: CoverageStatus,
): ParsedFindingEntry[] {
  const empty = coverageStatus === "Incomplete"
    ? EMPTY_INCOMPLETE_FINDINGS
    : EMPTY_COMPLETE_FINDINGS;
  if (lines.length === 1 && lines[0]?.raw === empty) return [];
  const records: ParsedFindingEntry[] = [];
  const ids = new Set<string>();
  let current: {
    id: ReviewFindingId;
    severity: ReviewFindingSeverity;
    title: string;
    body: SourceLine[];
  } | null = null;

  const commitCurrent = () => {
    if (!current) return;
    const fields = parseFields(current.body, FINDING_FIELDS, current.id, "- ");
    records.push({ ...current, fields });
    current = null;
  };

  for (const line of lines) {
    const match = /^### (F[1-9][0-9]*) · (Critical|High|Medium|Low) — (\S.*)$/u.exec(
      line.raw,
    );
    if (match) {
      commitCurrent();
      const parsedId = reviewFindingIdSchema.safeParse(match[1]);
      if (!parsedId.success) fail(line.line, "Finding ID слишком длинный");
      const id = parsedId.data;
      if (ids.has(id)) fail(line.line, `Finding ${id} повторяется`);
      if (records.length >= MAX_IMPLEMENTATION_REVIEW_FINDINGS) {
        fail(
          line.line,
          `implementation-review.md допускает не более ${MAX_IMPLEMENTATION_REVIEW_FINDINGS} активных findings`,
        );
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
    throw new ImplementationReviewReportError("Раздел Findings не содержит findings");
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
      const id = match[1]!;
      const title = match[2]!;
      if (!ACCEPTED_RISK_ID.test(id)) fail(line.line, "Accepted risk ID должен иметь вид AR<n>");
      if (ids.has(id)) fail(line.line, `Accepted risk ${id} повторяется`);
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
    throw new ImplementationReviewReportError("Пустой раздел Accepted risks нужно удалить");
  }
  return records;
}

function validateReviewCoverage(lines: readonly SourceLine[]): void {
  if (lines.length === 0) {
    throw new ImplementationReviewReportError("Раздел Review coverage не должен быть пустым");
  }
  for (const line of lines) {
    if (/^\s*(?:[#>|`~]|[-*+] |\d+[.)] |<!)|\*\*[^*]+:\*\*/u.test(line.raw)) {
      fail(line.line, "Review coverage должен содержать только prose");
    }
    if (PLACEHOLDER.test(line.raw)) fail(line.line, "Review coverage содержит placeholder");
  }
}

function validateAssessment(
  assessment: ParsedFields,
  coverageStatus: CoverageStatus,
): void {
  if (coverageStatus === "Incomplete" && !assessment.present.has("Coverage limitations")) {
    throw new ImplementationReviewReportError(
      "Incomplete review требует поле Coverage limitations",
    );
  }
  if (coverageStatus === "Complete" && assessment.present.has("Coverage limitations")) {
    throw new ImplementationReviewReportError(
      "Complete review не должен содержать Coverage limitations",
    );
  }
}

function validateConsistency(input: {
  readonly changeId: string;
  readonly result: ImplementationReviewResult;
  readonly coverageStatus: CoverageStatus;
  readonly assessment: ParsedFields;
  readonly reviewTarget: ParsedFields;
  readonly reviewUnits: readonly ParsedReviewUnit[];
  readonly unmappedRange: ParsedFields | null;
  readonly passes: readonly ParsedPass[];
  readonly findings: readonly ParsedFindingEntry[];
  readonly acceptedRisks: readonly ParsedAcceptedRiskEntry[];
}): void {
  const expectedResult = input.findings.length > 0
    ? "Changes needed"
    : input.coverageStatus === "Incomplete"
      ? "Incomplete"
      : "No unresolved findings";
  if (input.result !== expectedResult) {
    throw new ImplementationReviewReportError(
      `Поле Result должно иметь значение «${expectedResult}»`,
    );
  }
  if (input.passes.some(({ status }) => status === "Incomplete") && input.coverageStatus !== "Incomplete") {
    throw new ImplementationReviewReportError(
      "Незавершённый review pass требует Coverage status: Incomplete",
    );
  }
  if (input.reviewUnits.length === 0 && input.coverageStatus !== "Incomplete") {
    throw new ImplementationReviewReportError(
      "Отсутствие review units требует Coverage status: Incomplete",
    );
  }

  const openSpecChange = valueAsString(input.reviewTarget, "OpenSpec change");
  if (openSpecChange !== input.changeId) {
    throw new ImplementationReviewReportError(
      "OpenSpec change в Review target должен совпадать с заголовком",
    );
  }
  const baseCommit = valueAsString(input.reviewTarget, "Base commit");
  const reviewedHead = valueAsString(input.reviewTarget, "Reviewed head");
  const targetCommits = valueAsStringArray(input.reviewTarget, "Target commits");
  if (baseCommit === reviewedHead) {
    throw new ImplementationReviewReportError("Base commit и Reviewed head должны различаться");
  }
  if (
    [baseCommit, reviewedHead, ...targetCommits].some(
      (commit) => commit.length !== baseCommit.length,
    ) ||
    !targetCommits.includes(reviewedHead) ||
    targetCommits.includes(baseCommit)
  ) {
    throw new ImplementationReviewReportError(
      "Target commits должны использовать один hash-формат, включать Reviewed head и исключать Base commit",
    );
  }

  const inventory = new Set(valueAsStringArray(input.reviewTarget, "Reviewable paths"));
  const planning = new Set(
    input.reviewTarget.present.has("Planning evidence paths")
      ? valueAsStringArray(input.reviewTarget, "Planning evidence paths")
      : [],
  );
  const unmapped = new Set(
    input.unmappedRange
      ? valueAsStringArray(input.unmappedRange, "Unmatched target paths")
      : [],
  );
  const delivery = new Set(input.reviewUnits.flatMap((unit) => unit.implementationTarget));
  for (const paths of [planning, unmapped, delivery]) {
    for (const path of paths) {
      if (!inventory.has(path)) {
        throw new ImplementationReviewReportError(
          `Путь ${JSON.stringify(path)} находится вне Reviewable paths`,
        );
      }
    }
  }
  for (const path of inventory) {
    const roles = [planning, unmapped, delivery].filter((group) => group.has(path)).length;
    if (roles !== 1) {
      throw new ImplementationReviewReportError(
        `Путь ${JSON.stringify(path)} должен иметь ровно одну роль в review target`,
      );
    }
  }

  const activeIds = new Set(input.findings.map(({ id }) => id));
  const riskIds = new Set(input.acceptedRisks.map(({ id }) => id));
  const origins = new Set<string>();
  const summary = valueAsString(input.assessment, "Summary");
  for (const risk of input.acceptedRisks) {
    const origin = valueAsString(risk.fields, "Originating finding");
    if (activeIds.has(origin) || origins.has(origin)) {
      throw new ImplementationReviewReportError(
        `Accepted risk ${risk.id} содержит некорректный Originating finding`,
      );
    }
    origins.add(origin);
    if (
      valueAsString(risk.fields, "Acceptance lifetime") === "Durable" &&
      !risk.fields.present.has("Decision record")
    ) {
      throw new ImplementationReviewReportError(
        `Accepted risk ${risk.id} с Durable lifetime требует Decision record`,
      );
    }
    if (!new RegExp(`\\b${risk.id}\\b`, "u").test(summary)) {
      throw new ImplementationReviewReportError(`Summary должен упоминать ${risk.id}`);
    }
  }
  for (const reference of summary.match(/\bAR[1-9][0-9]*\b/gu) ?? []) {
    if (!riskIds.has(reference)) {
      throw new ImplementationReviewReportError(`Summary ссылается на отсутствующий ${reference}`);
    }
  }

  for (const entry of [...input.findings, ...input.acceptedRisks]) {
    const evidenceRevisions = valueAsStringArray(entry.fields, "Evidence revisions");
    const carried = entry.fields.present.has("Current target relation");
    if (
      !carried &&
      evidenceRevisions.some(
        (commit) => commit !== baseCommit && commit !== reviewedHead,
      )
    ) {
      throw new ImplementationReviewReportError(
        `${entry.id} с более старым evidence требует Current target relation`,
      );
    }
  }
}

function valueAsString(fields: ParsedFields, label: string): string {
  const value = fields.values.get(label);
  if (typeof value !== "string") {
    throw new ImplementationReviewReportError(`Поле ${label} имеет некорректный тип`);
  }
  return value;
}

function valueAsStringArray(fields: ParsedFields, label: string): readonly string[] {
  const value = fields.values.get(label);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ImplementationReviewReportError(`Поле ${label} имеет некорректный тип`);
  }
  return value;
}

function valueAsEnum<const Values extends readonly string[]>(
  fields: ParsedFields,
  label: string,
  values: Values,
): Values[number] {
  const value = valueAsString(fields, label);
  if (!values.includes(value)) {
    throw new ImplementationReviewReportError(`Поле ${label} содержит неизвестное значение`);
  }
  return value as Values[number];
}

function fail(line: number, message: string): never {
  throw new ImplementationReviewReportError(
    `Некорректный implementation-review.md, строка ${line}: ${message}`,
  );
}
