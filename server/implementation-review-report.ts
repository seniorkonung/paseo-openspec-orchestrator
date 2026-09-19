import { lstat, readFile, realpath } from "node:fs/promises";
import { relative } from "node:path";
import {
  extractReviewFindingReferences,
  MAX_CHANGE_REVIEW_FINDINGS,
  type ChangeReviewAcceptedRisk,
  type ChangeReviewFinding,
} from "./change-review-report.ts";

export const MAX_IMPLEMENTATION_REVIEW_BYTES = 1024 * 1024;
export const MAX_IMPLEMENTATION_REVIEW_FINDINGS = MAX_CHANGE_REVIEW_FINDINGS;

export type ImplementationReviewFinding = ChangeReviewFinding;
export type ImplementationReviewAcceptedRisk = ChangeReviewAcceptedRisk;

export interface ParsedImplementationReviewReport {
  readonly findings: readonly ImplementationReviewFinding[];
  readonly acceptedRisks: readonly ImplementationReviewAcceptedRisk[];
}

export interface ReadImplementationReviewReportRequest {
  readonly reviewPath: string;
  readonly changeRoot: string;
  readonly expectedChangeId: string;
  readonly inspectPath?: typeof lstat;
  readonly resolveRealPath?: typeof realpath;
  readonly readBytes?: typeof readFile;
}

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
  if (reviewStat.size > MAX_IMPLEMENTATION_REVIEW_BYTES) {
    throw new ImplementationReviewReportError(
      `Допустимый размер implementation-review.md — не больше ${MAX_IMPLEMENTATION_REVIEW_BYTES} байт`,
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
  _expectedChangeId?: string,
): ParsedImplementationReviewReport {
  return extractReviewFindingReferences(source);
}
