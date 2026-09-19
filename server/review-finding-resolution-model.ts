import type { lstat, realpath } from "node:fs/promises";
import { z } from "zod";
import {
  type CompletedFindingPullRequest,
  type ReviewFindingOutcome,
  type ReviewFindingPublicationKind,
} from "./review-finding-publication.ts";
import {
  type ReviewFindingId,
} from "./change-review-report.ts";
import type { RepoLocalChangePaths } from "./repo-local-change.ts";

export const findingResolutionBranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u,
    "Имя Git-ветки содержит небезопасные символы",
  )
  .refine(
    (value) =>
      value !== "@" &&
      value !== "main" &&
      !value.includes("..") &&
      !value.includes("//") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")),
    "Для устранения finding требуется безопасное имя non-main Git-ветки",
  );

export interface ReviewFindingResolutionSession {
  readonly changeId: string;
  readonly branch: string;
  readonly findingId: ReviewFindingId;
  readonly baselineCommit: string;
}

export type ReviewFindingResolutionPlan<Session extends ReviewFindingResolutionSession> =
  | {
      readonly kind: "no-findings";
      readonly reviewPath: string;
      readonly headCommit: string;
    }
  | {
      readonly kind: "finding-required";
      readonly findingId: ReviewFindingId;
      readonly session: Session;
    };

export interface CompletedReviewFindingResolution {
  readonly changeId: string;
  readonly findingId: ReviewFindingId;
  readonly remainingFindingIds: readonly ReviewFindingId[];
  readonly commit: string;
  readonly outcome: ReviewFindingOutcome;
  readonly pullRequest: CompletedFindingPullRequest;
}

export interface VerifiedReviewFindingResolution {
  readonly changeId: string;
  readonly findingId: ReviewFindingId;
  readonly remainingFindingIds: readonly ReviewFindingId[];
  readonly commit: string;
  readonly outcome: ReviewFindingOutcome;
}

export interface FindingResolutionContext extends RepoLocalChangePaths {
  readonly changeId: string;
  readonly reviewPath: string;
  readonly reviewRepositoryPath: string;
}

export interface ReviewFindingReportLocation {
  readonly reviewPath: string;
  readonly changeRoot: string;
  readonly expectedChangeId: string;
  readonly inspectPath: typeof lstat;
  readonly resolveRealPath: typeof realpath;
}

export interface ActiveReviewFindingReport {
  readonly findings: readonly { readonly id: ReviewFindingId }[];
  readonly acceptedRisks: readonly {
    readonly id: string;
    readonly originatingFindingId: string;
  }[];
}

export interface ReviewFindingPromptInput {
  readonly changeId: string;
  readonly findingId: ReviewFindingId;
  readonly branch: string;
  readonly reviewRepositoryPath: string;
  readonly alreadyCommitted: boolean;
  readonly publicationAlreadyCompleted: boolean;
}

export interface ReviewFindingResolutionBehavior<
  Session extends ReviewFindingResolutionSession,
> {
  readonly sessionSchema: z.ZodType<Session>;
  readonly report: {
    readonly fileName: string;
    readonly missingMeansNoFindings: boolean;
    readonly read: (
      location: ReviewFindingReportLocation,
      signal?: AbortSignal,
    ) => Promise<ActiveReviewFindingReport>;
  };
  readonly agent: {
    readonly toolName: string;
    readonly toolDescription: string;
    readonly title: (findingId: ReviewFindingId) => string;
    readonly logLabel: string;
    readonly completionLabel: string;
    readonly prompt: (input: ReviewFindingPromptInput) => string;
  };
  readonly publication: {
    readonly kind: ReviewFindingPublicationKind;
    readonly commitSubject: (findingId: ReviewFindingId) => string;
  };
}

export class ReviewFindingResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewFindingResolutionError";
  }
}

export function parseFindingResolutionBranch(branch: string): string {
  const parsed = findingResolutionBranchSchema.safeParse(branch);
  if (!parsed.success) {
    throw new ReviewFindingResolutionError(
      "Для устранения finding требуется безопасное имя non-main Git-ветки",
    );
  }
  return parsed.data;
}
