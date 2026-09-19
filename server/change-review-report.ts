import { lstat, readFile, realpath } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";

export const MAX_CHANGE_REVIEW_BYTES = 1024 * 1024;
export const MAX_CHANGE_REVIEW_FINDINGS = 256;

export const reviewFindingIdSchema = z
  .string()
  .regex(/^F[1-9][0-9]*$/u)
  .max(32);

export type ReviewFindingId = z.infer<typeof reviewFindingIdSchema>;

export interface ChangeReviewFinding {
  readonly id: ReviewFindingId;
}

export interface ChangeReviewAcceptedRisk {
  readonly originatingFindingId: ReviewFindingId;
}

export interface ParsedChangeReviewReport {
  readonly findings: readonly ChangeReviewFinding[];
  readonly acceptedRisks: readonly ChangeReviewAcceptedRisk[];
}

export interface ReadChangeReviewReportRequest {
  readonly reviewPath: string;
  readonly changeRoot: string;
  readonly expectedChangeId: string;
  readonly inspectPath?: typeof lstat;
  readonly resolveRealPath?: typeof realpath;
  readonly readBytes?: typeof readFile;
}

const MARKDOWN_HEADING = /^\s{0,3}#{1,6}[ \t]+(.+?)\s*$/u;
const FINDING_HEADING = /^(F[1-9][0-9]*)\b/u;
const ACCEPTED_RISK_HEADING = /^AR[1-9][0-9]*\b/u;
const ORIGINATING_FINDING =
  /^\s*(?:[-*+][ \t]+)?(?:\*\*)?Originating[ \t]+finding:(?:\*\*)?[ \t]+(F[1-9][0-9]*)\b/iu;

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
  if (reviewStat.size > MAX_CHANGE_REVIEW_BYTES) {
    throw new ChangeReviewReportError(
      `Допустимый размер review.md — не больше ${MAX_CHANGE_REVIEW_BYTES} байт`,
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
  _expectedChangeId?: string,
): ParsedChangeReviewReport {
  return extractReviewFindingReferences(source);
}

export function extractReviewFindingReferences(
  source: string,
): ParsedChangeReviewReport {
  const findings: ChangeReviewFinding[] = [];
  const acceptedRisks: ChangeReviewAcceptedRisk[] = [];
  const findingIds = new Set<ReviewFindingId>();
  const acceptedFindingIds = new Set<ReviewFindingId>();
  let insideAcceptedRisk = false;
  let fence: { marker: "`" | "~"; length: number } | null = null;

  const lines = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split("\n");
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fenceMatch) {
      const marker = fenceMatch[0] as "`" | "~";
      if (!fence) fence = { marker, length: fenceMatch.length };
      else if (marker === fence.marker && fenceMatch.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = MARKDOWN_HEADING.exec(line)?.[1];
    if (heading !== undefined) {
      insideAcceptedRisk = ACCEPTED_RISK_HEADING.test(heading);
      const parsedId = reviewFindingIdSchema.safeParse(
        FINDING_HEADING.exec(heading)?.[1],
      );
      if (
        parsedId.success &&
        !findingIds.has(parsedId.data) &&
        findings.length < MAX_CHANGE_REVIEW_FINDINGS
      ) {
        findingIds.add(parsedId.data);
        findings.push(Object.freeze({ id: parsedId.data }));
      }
      continue;
    }
    if (!insideAcceptedRisk) continue;
    const parsedOrigin = reviewFindingIdSchema.safeParse(
      ORIGINATING_FINDING.exec(line)?.[1],
    );
    if (
      parsedOrigin.success &&
      !acceptedFindingIds.has(parsedOrigin.data) &&
      acceptedRisks.length < MAX_CHANGE_REVIEW_FINDINGS
    ) {
      acceptedFindingIds.add(parsedOrigin.data);
      acceptedRisks.push(Object.freeze({ originatingFindingId: parsedOrigin.data }));
    }
  }

  return Object.freeze({
    findings: Object.freeze(findings),
    acceptedRisks: Object.freeze(acceptedRisks),
  });
}
