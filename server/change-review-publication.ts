import { z } from "zod";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { changeBranchFor, changeBranchSchema } from "./change-branch.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  assertCleanReviewWorktree,
  listReviewPullRequests,
  readCurrentReviewBranch,
  readRemoteReviewBranchCommit,
  readReviewHeadCommit,
  readReviewPullRequest,
  resolveReviewRepository,
} from "./review-publication-gateway.ts";
import {
  ChangeReviewPublicationError,
  assertPullRequestRepository,
  githubHostSchema,
  httpsUrlSchema,
  pullRequestNumberSchema,
  repositoryArgument,
  repositoryNameWithOwnerSchema,
  reviewPullRequestBody,
  reviewPullRequestTitle,
  type ReviewPullRequest,
} from "./review-publication-model.ts";
import { deliverRootCommit } from "./root-branch-delivery.ts";

export { ChangeReviewPublicationError, reviewPullRequestBody, reviewPullRequestTitle } from "./review-publication-model.ts";

export const reviewPublicationTargetSchema = z.object({
  parentBranch: changeBranchSchema,
  reviewBranch: changeBranchSchema,
  parentBaselineCommit: commitHashSchema,
  baselineCommit: commitHashSchema,
  repositoryHost: githubHostSchema,
  repositoryNameWithOwner: repositoryNameWithOwnerSchema,
  repositoryUrl: httpsUrlSchema,
  parentPullRequestNumber: pullRequestNumberSchema,
}).strict().superRefine((target, context) => {
  if (target.parentBranch !== target.reviewBranch ||
      target.parentBaselineCommit !== target.baselineCommit) {
    context.addIssue({ code: "custom", path: ["reviewBranch"], message: "Review должен продолжать корневую ветку change" });
  }
});
export type ReviewPublicationTarget = z.infer<typeof reviewPublicationTargetSchema>;
export interface CompletedReviewPullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
}

function repositoryOf(target: ReviewPublicationTarget) {
  return {
    host: target.repositoryHost,
    nameWithOwner: target.repositoryNameWithOwner,
    url: target.repositoryUrl,
  };
}

async function assertRootPr(
  workspaceDirectory: string,
  changeId: string,
  branch: string,
  expectedHead: string,
  expectedNumber: number | null,
  signal: AbortSignal | undefined,
  command: BoundedCommandRunner,
): Promise<{ readonly pr: ReviewPullRequest; readonly repository: Awaited<ReturnType<typeof resolveReviewRepository>> }> {
  const repository = await resolveReviewRepository(command, workspaceDirectory, signal);
  const requests = await listReviewPullRequests(command, workspaceDirectory, repositoryArgument(repository), branch, "all", signal);
  if (requests.length !== 1 || (expectedNumber !== null && requests[0]!.number !== expectedNumber)) {
    throw new ChangeReviewPublicationError("Корневой PR изменился во время review");
  }
  const pr = await readReviewPullRequest(command, workspaceDirectory, repositoryArgument(repository), requests[0]!.number, signal);
  assertPullRequestRepository(pr, repository.url);
  if (pr.state !== "OPEN" || !pr.isDraft || pr.isCrossRepository ||
      pr.baseRefName !== "main" || pr.headRefName !== changeBranchFor(changeId) ||
      pr.headRefOid !== expectedHead) {
    throw new ChangeReviewPublicationError("Корневой Draft PR не соответствует HEAD change");
  }
  return { pr, repository };
}

export async function prepareReviewPublication(
  workspaceDirectory: string,
  changeIdInput: string,
  parentBranchInput: string,
  reviewBranchInput: string,
  signal?: AbortSignal,
  command: BoundedCommandRunner = runBoundedCommand,
): Promise<ReviewPublicationTarget> {
  const changeId = openSpecChangeIdSchema.parse(changeIdInput);
  const parentBranch = changeBranchSchema.parse(parentBranchInput);
  const reviewBranch = changeBranchSchema.parse(reviewBranchInput);
  if (parentBranch !== changeBranchFor(changeId) || reviewBranch !== parentBranch) {
    throw new ChangeReviewPublicationError("Review должен идти в корневой ветке change");
  }
  await assertCleanReviewWorktree(command, workspaceDirectory, signal);
  const [current, local, remote] = await Promise.all([
    readCurrentReviewBranch(command, workspaceDirectory, signal),
    readReviewHeadCommit(command, workspaceDirectory, signal),
    readRemoteReviewBranchCommit(command, workspaceDirectory, parentBranch, signal),
  ]);
  if (current !== parentBranch || local !== remote) {
    throw new ChangeReviewPublicationError("Корневая ветка расходится с origin перед review");
  }
  const { pr, repository } = await assertRootPr(workspaceDirectory, changeId, parentBranch, remote, null, signal, command);
  return reviewPublicationTargetSchema.parse({
    parentBranch, reviewBranch,
    parentBaselineCommit: local, baselineCommit: local,
    repositoryHost: repository.host,
    repositoryNameWithOwner: repository.nameWithOwner,
    repositoryUrl: repository.url,
    parentPullRequestNumber: pr.number,
  });
}

export async function assertReviewPublicationRecovery(
  workspaceDirectory: string,
  targetInput: ReviewPublicationTarget,
  changeIdInput: string,
  signal?: AbortSignal,
  command: BoundedCommandRunner = runBoundedCommand,
): Promise<void> {
  const target = reviewPublicationTargetSchema.parse(targetInput);
  const changeId = openSpecChangeIdSchema.parse(changeIdInput);
  if (target.parentBranch !== changeBranchFor(changeId)) throw new ChangeReviewPublicationError("Review относится к другому change");
  await assertCleanReviewWorktree(command, workspaceDirectory, signal);
  const [current, local, remote, repository] = await Promise.all([
    readCurrentReviewBranch(command, workspaceDirectory, signal),
    readReviewHeadCommit(command, workspaceDirectory, signal),
    readRemoteReviewBranchCommit(command, workspaceDirectory, target.parentBranch, signal),
    resolveReviewRepository(command, workspaceDirectory, signal),
  ]);
  if (repository.host !== target.repositoryHost ||
      repository.nameWithOwner.toLowerCase() !== target.repositoryNameWithOwner.toLowerCase() ||
      repository.url !== target.repositoryUrl ||
      current !== target.parentBranch ||
      (remote !== target.baselineCommit && remote !== local)) {
    throw new ChangeReviewPublicationError("Состояние ветки или репозитория изменилось во время review");
  }
  await assertRootPr(workspaceDirectory, changeId, target.parentBranch, remote, target.parentPullRequestNumber, signal, command);
}

export async function verifyReviewPullRequest(
  workspaceDirectory: string,
  targetInput: ReviewPublicationTarget,
  changeIdInput: string,
  expectedHead: string,
  signal?: AbortSignal,
  command: BoundedCommandRunner = runBoundedCommand,
): Promise<CompletedReviewPullRequest> {
  const target = reviewPublicationTargetSchema.parse(targetInput);
  const changeId = openSpecChangeIdSchema.parse(changeIdInput);
  if (target.parentBranch !== changeBranchFor(changeId)) throw new ChangeReviewPublicationError("Review относится к другому change");
  await deliverRootCommit(workspaceDirectory, changeId, target.baselineCommit, expectedHead, signal, command);
  const { pr, repository } = await assertRootPr(workspaceDirectory, changeId, target.parentBranch, expectedHead, target.parentPullRequestNumber, signal, command);
  const saved = repositoryOf(target);
  if (repository.host !== saved.host ||
      repository.nameWithOwner.toLowerCase() !== saved.nameWithOwner.toLowerCase() ||
      repository.url !== saved.url) {
    throw new ChangeReviewPublicationError("Репозиторий origin изменился");
  }
  return { number: pr.number, url: pr.url, title: pr.title };
}
