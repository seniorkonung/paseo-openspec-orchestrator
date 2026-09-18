import { z } from "zod";
import {
  assertPlanningBranchFor,
  changeBranchFor,
  changeBranchSchema,
  planningBranchFor,
  planningBranchSchema,
} from "./change-branch.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-command.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  assertCleanReviewWorktree,
  assertReviewCommitDescendsFrom,
  listReviewPullRequests,
  readCurrentReviewBranch,
  readLocalReviewBranchCommit,
  readOptionalRemoteReviewBranchCommit,
  readRemoteReviewBranchCommit,
  readReviewHeadCommit,
  readReviewPullRequest,
  resolveReviewRepository,
} from "./review-publication-gateway.ts";
import {
  ChangeReviewPublicationError,
  REVIEW_PARENT_BRANCH,
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

export {
  ChangeReviewPublicationError,
  reviewPullRequestBody,
  reviewPullRequestTitle,
} from "./review-publication-model.ts";

export const reviewPublicationTargetSchema = z
  .object({
    parentBranch: changeBranchSchema,
    reviewBranch: planningBranchSchema,
    parentBaselineCommit: commitHashSchema,
    baselineCommit: commitHashSchema,
    repositoryHost: githubHostSchema,
    repositoryNameWithOwner: repositoryNameWithOwnerSchema,
    repositoryUrl: httpsUrlSchema,
    parentPullRequestNumber: pullRequestNumberSchema,
  })
  .strict();

export type ReviewPublicationTarget = z.infer<typeof reviewPublicationTargetSchema>;

export interface CompletedReviewPullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
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
  const reviewBranch = planningBranchSchema.parse(reviewBranchInput);
  if (parentBranch !== changeBranchFor(changeId)) {
    throw new ChangeReviewPublicationError(
      "Корневая Git-ветка не соответствует OpenSpec change",
    );
  }
  assertPlanningBranchFor(reviewBranch, changeId);
  await assertCleanReviewWorktree(command, workspaceDirectory, signal);

  const [currentBranch, baselineCommit, parentBaselineCommit, repository] =
    await Promise.all([
      readCurrentReviewBranch(command, workspaceDirectory, signal),
      readReviewHeadCommit(command, workspaceDirectory, signal),
      readLocalReviewBranchCommit(command, workspaceDirectory, parentBranch, signal),
      resolveReviewRepository(command, workspaceDirectory, signal),
    ]);
  if (currentBranch !== reviewBranch) {
    throw new ChangeReviewPublicationError(
      `Перед review должна быть активна planning-ветка «${reviewBranch}»`,
    );
  }
  if (parentBaselineCommit === null) {
    throw new ChangeReviewPublicationError(
      `Корневая ветка «${parentBranch}» отсутствует среди локальных refs`,
    );
  }

  const [remoteParent, remoteReview, parentPullRequests, previousReviewPullRequests] =
    await Promise.all([
      readRemoteReviewBranchCommit(command, workspaceDirectory, parentBranch, signal),
      readRemoteReviewBranchCommit(command, workspaceDirectory, reviewBranch, signal),
      listReviewPullRequests(
        command,
        workspaceDirectory,
        repositoryArgument(repository),
        parentBranch,
        "open",
        signal,
      ),
      listReviewPullRequests(
        command,
        workspaceDirectory,
        repositoryArgument(repository),
        reviewBranch,
        "all",
        signal,
      ),
    ]);
  if (remoteParent !== parentBaselineCommit) {
    throw new ChangeReviewPublicationError(
      `Корневая ветка «${parentBranch}» расходится с origin`,
    );
  }
  if (remoteReview !== baselineCommit) {
    throw new ChangeReviewPublicationError(
      `Git remote origin не содержит текущий HEAD planning-ветки «${reviewBranch}»`,
    );
  }
  if (parentPullRequests.length !== 1) {
    throw new ChangeReviewPublicationError(
      `Для корневой ветки «${parentBranch}» должен существовать ровно один открытый pull request`,
    );
  }
  const parentPullRequest = parentPullRequests[0]!;
  assertPullRequestRepository(parentPullRequest, repository.url);
  assertParentPullRequest(parentPullRequest, parentBranch, parentBaselineCommit);
  if (previousReviewPullRequests.length > 0) {
    throw new ChangeReviewPublicationError(
      `Для planning-ветки «${reviewBranch}» уже существует pull request`,
    );
  }

  return reviewPublicationTargetSchema.parse({
    parentBranch,
    reviewBranch,
    parentBaselineCommit,
    baselineCommit,
    repositoryHost: repository.host,
    repositoryNameWithOwner: repository.nameWithOwner,
    repositoryUrl: repository.url,
    parentPullRequestNumber: parentPullRequest.number,
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
  assertTargetBranches(target, changeId);
  await assertCleanReviewWorktree(command, workspaceDirectory, signal);
  await assertParentPublication(command, workspaceDirectory, target, signal);

  const currentBranch = await readCurrentReviewBranch(
    command,
    workspaceDirectory,
    signal,
  );
  if (currentBranch !== target.reviewBranch) {
    throw new ChangeReviewPublicationError(
      `Для восстановления review требуется planning-ветка «${target.reviewBranch}»`,
    );
  }
  const localReviewHead = await readLocalReviewBranchCommit(
    command,
    workspaceDirectory,
    target.reviewBranch,
    signal,
  );
  if (localReviewHead === null) {
    throw new ChangeReviewPublicationError(
      "Активная planning-ветка отсутствует среди локальных refs",
    );
  }
  await assertReviewCommitDescendsFrom(
    command,
    workspaceDirectory,
    target.baselineCommit,
    localReviewHead,
    "Planning-ветка больше не продолжает baseline артефактов",
    signal,
  );

  const remoteReviewHead = await readOptionalRemoteReviewBranchCommit(
    command,
    workspaceDirectory,
    target.reviewBranch,
    signal,
  );
  if (
    remoteReviewHead !== target.baselineCommit &&
    remoteReviewHead !== localReviewHead
  ) {
    throw new ChangeReviewPublicationError(
      `Git remote origin содержит неожиданное состояние planning-ветки «${target.reviewBranch}»`,
    );
  }

  const openReviewPullRequests = await listReviewPullRequests(
    command,
    workspaceDirectory,
    targetRepositoryArgument(target),
    target.reviewBranch,
    "open",
    signal,
  );
  if (openReviewPullRequests.length > 1) {
    throw new ChangeReviewPublicationError(
      `Для planning-ветки «${target.reviewBranch}» найдено несколько открытых pull request`,
    );
  }
  const existing = openReviewPullRequests[0];
  if (existing) {
    const pullRequest = await readReviewPullRequest(
      command,
      workspaceDirectory,
      targetRepositoryArgument(target),
      existing.number,
      signal,
    );
    assertPullRequestRepository(pullRequest, target.repositoryUrl);
    assertReadyReviewPullRequest(pullRequest, target, changeId, remoteReviewHead);
  } else {
    const previousPullRequests = await listReviewPullRequests(
      command,
      workspaceDirectory,
      targetRepositoryArgument(target),
      target.reviewBranch,
      "all",
      signal,
    );
    if (previousPullRequests.length > 0) {
      throw new ChangeReviewPublicationError(
        "Созданный planning pull request больше не открыт; автоматическое создание замены запрещено",
      );
    }
  }
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
  const head = commitHashSchema.parse(expectedHead);
  assertTargetBranches(target, changeId);
  await assertParentPublication(command, workspaceDirectory, target, signal);

  const currentBranch = await readCurrentReviewBranch(
    command,
    workspaceDirectory,
    signal,
  );
  if (currentBranch !== target.reviewBranch) {
    throw new ChangeReviewPublicationError(
      `Текущая Git-ветка должна быть planning-веткой «${target.reviewBranch}»`,
    );
  }
  const remoteHead = await readRemoteReviewBranchCommit(
    command,
    workspaceDirectory,
    target.reviewBranch,
    signal,
  );
  if (remoteHead !== head) {
    throw new ChangeReviewPublicationError(
      `Git remote origin не содержит текущий HEAD planning-ветки «${target.reviewBranch}»`,
    );
  }

  const openPullRequests = await listReviewPullRequests(
    command,
    workspaceDirectory,
    targetRepositoryArgument(target),
    target.reviewBranch,
    "open",
    signal,
  );
  if (openPullRequests.length !== 1) {
    throw new ChangeReviewPublicationError(
      `Для planning-ветки «${target.reviewBranch}» должен существовать ровно один открытый pull request`,
    );
  }
  const pullRequest = await readReviewPullRequest(
    command,
    workspaceDirectory,
    targetRepositoryArgument(target),
    openPullRequests[0]!.number,
    signal,
  );
  assertPullRequestRepository(pullRequest, target.repositoryUrl);
  assertReadyReviewPullRequest(pullRequest, target, changeId, head);
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    title: pullRequest.title,
  };
}

function assertTargetBranches(
  target: ReviewPublicationTarget,
  changeId: string,
): void {
  if (target.parentBranch !== changeBranchFor(changeId)) {
    throw new ChangeReviewPublicationError(
      "Сохранённая корневая ветка не соответствует OpenSpec change",
    );
  }
  if (target.reviewBranch !== planningBranchFor(changeId)) {
    throw new ChangeReviewPublicationError(
      "Сохранённая planning-ветка не соответствует OpenSpec change",
    );
  }
}

async function assertParentPublication(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  target: ReviewPublicationTarget,
  signal?: AbortSignal,
): Promise<void> {
  const repository = await resolveReviewRepository(command, workspaceDirectory, signal);
  if (
    repository.host !== target.repositoryHost ||
    repository.nameWithOwner.toLowerCase() !==
      target.repositoryNameWithOwner.toLowerCase() ||
    repository.url !== target.repositoryUrl
  ) {
    throw new ChangeReviewPublicationError(
      "Git remote origin больше не соответствует сохранённому GitHub-репозиторию",
    );
  }
  const [localParent, remoteParent] = await Promise.all([
    readLocalReviewBranchCommit(command, workspaceDirectory, target.parentBranch, signal),
    readRemoteReviewBranchCommit(command, workspaceDirectory, target.parentBranch, signal),
  ]);
  if (
    localParent !== target.parentBaselineCommit ||
    remoteParent !== target.parentBaselineCommit
  ) {
    throw new ChangeReviewPublicationError(
      `Корневая ветка «${target.parentBranch}» изменилась после начала review`,
    );
  }

  const openParentPullRequests = await listReviewPullRequests(
    command,
    workspaceDirectory,
    targetRepositoryArgument(target),
    target.parentBranch,
    "open",
    signal,
  );
  if (
    openParentPullRequests.length !== 1 ||
    openParentPullRequests[0]!.number !== target.parentPullRequestNumber
  ) {
    throw new ChangeReviewPublicationError(
      "Открытый pull request корневой ветки изменился после начала review",
    );
  }
  const parentPullRequest = await readReviewPullRequest(
    command,
    workspaceDirectory,
    targetRepositoryArgument(target),
    target.parentPullRequestNumber,
    signal,
  );
  assertPullRequestRepository(parentPullRequest, target.repositoryUrl);
  assertParentPullRequest(
    parentPullRequest,
    target.parentBranch,
    target.parentBaselineCommit,
  );
}

function assertParentPullRequest(
  pullRequest: ReviewPullRequest,
  parentBranch: string,
  baselineCommit: string,
): void {
  if (
    pullRequest.state !== "OPEN" ||
    pullRequest.isCrossRepository ||
    pullRequest.baseRefName !== REVIEW_PARENT_BRANCH ||
    pullRequest.headRefName !== parentBranch ||
    pullRequest.headRefOid !== baselineCommit
  ) {
    throw new ChangeReviewPublicationError(
      `Pull request корневой ветки должен быть открыт из «${parentBranch}» в «${REVIEW_PARENT_BRANCH}» и содержать её текущий HEAD`,
    );
  }
}

function assertReadyReviewPullRequest(
  pullRequest: ReviewPullRequest,
  target: ReviewPublicationTarget,
  changeId: string,
  expectedHead: string | null,
): void {
  if (
    expectedHead === null ||
    pullRequest.state !== "OPEN" ||
    pullRequest.isDraft ||
    pullRequest.isCrossRepository ||
    pullRequest.headRefName !== target.reviewBranch ||
    pullRequest.baseRefName !== target.parentBranch ||
    pullRequest.headRefOid !== expectedHead ||
    pullRequest.title !== reviewPullRequestTitle(changeId) ||
    pullRequest.body !== reviewPullRequestBody(changeId)
  ) {
    throw new ChangeReviewPublicationError(
      "Planning pull request не соответствует сохранённой Ready-публикации",
    );
  }
}

function targetRepositoryArgument(target: ReviewPublicationTarget): string {
  return repositoryArgument({
    host: target.repositoryHost,
    nameWithOwner: target.repositoryNameWithOwner,
  });
}
