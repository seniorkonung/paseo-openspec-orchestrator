import { z } from "zod";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  reviewPublicationTargetSchema,
  type CompletedReviewPullRequest,
} from "./change-review-publication.ts";
import type { RepoLocalChangePaths } from "./repo-local-change.ts";

const FALLBACK_COMMIT_SUBJECT = "docs(openspec): add change review";

export const pendingReviewSessionSchema = reviewPublicationTargetSchema.safeExtend({
  changeId: openSpecChangeIdSchema,
});

export type PendingReviewSession = z.infer<typeof pendingReviewSessionSchema>;

export interface CompletedChangeReview {
  readonly changeId: string;
  readonly reviewPath: string;
  readonly branch: string;
  readonly pullRequest: CompletedReviewPullRequest;
}

export interface ReviewContext extends RepoLocalChangePaths {
  readonly changeId: string;
  readonly reviewPath: string;
  readonly reviewRepositoryPath: string;
}

export class ChangeReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeReviewError";
  }
}

export function reviewCommitSubject(changeId: string): string {
  const detailed = `docs(openspec): add ${parseReviewChangeId(changeId)} review`;
  return detailed.length <= 71 ? detailed : FALLBACK_COMMIT_SUBJECT;
}

export function reviewPublicationTarget(
  session: PendingReviewSession,
): z.output<typeof reviewPublicationTargetSchema> {
  return reviewPublicationTargetSchema.parse({
    parentBranch: session.parentBranch,
    reviewBranch: session.reviewBranch,
    baselineCommit: session.baselineCommit,
    repositoryHost: session.repositoryHost,
    repositoryNameWithOwner: session.repositoryNameWithOwner,
    repositoryUrl: session.repositoryUrl,
    parentPullRequestNumber: session.parentPullRequestNumber,
  });
}

export function parseReviewChangeId(changeId: string): string {
  const parsed = openSpecChangeIdSchema.safeParse(changeId);
  if (!parsed.success) throw new ChangeReviewError("Change ID должен быть в kebab-case");
  return parsed.data;
}
