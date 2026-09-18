import { z } from "zod";
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
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
  REVIEW_BRANCH_SUFFIX,
  REVIEW_PARENT_BRANCH,
  assertPullRequestRepository,
  githubHostSchema,
  httpsUrlSchema,
  parseReviewBranch,
  pullRequestNumberSchema,
  repositoryArgument,
  repositoryNameWithOwnerSchema,
  reviewBranchSchema,
  reviewPullRequestBody,
  reviewPullRequestTitle,
  type ReviewPullRequest,
} from "./review-publication-model.ts";

export {
  ChangeReviewPublicationError,
  reviewBranchSchema,
  reviewPullRequestBody,
  reviewPullRequestTitle,
} from "./review-publication-model.ts";

export const reviewPublicationTargetSchema = z
  .object({
    parentBranch: reviewBranchSchema,
    reviewBranch: reviewBranchSchema,
    baselineCommit: commitHashSchema,
    repositoryHost: githubHostSchema,
    repositoryNameWithOwner: repositoryNameWithOwnerSchema,
    repositoryUrl: httpsUrlSchema,
    parentPullRequestNumber: pullRequestNumberSchema,
  })
  .strict()
  .superRefine((target, context) => {
    if (target.reviewBranch !== `${target.parentBranch}${REVIEW_BRANCH_SUFFIX}`) {
      context.addIssue({
        code: "custom",
        path: ["reviewBranch"],
        message: "Review-ветка не соответствует сохранённой parent-ветке",
      });
    }
  });

export type ReviewPublicationTarget = z.infer<typeof reviewPublicationTargetSchema>;

export interface CompletedReviewPullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
}

export async function prepareReviewPublication(
  workspaceDirectory: string,
  parentBranch: string,
  signal?: AbortSignal,
  command: BoundedCommandRunner = runBoundedCommand,
): Promise<ReviewPublicationTarget> {
  const parsedParent = parseReviewBranch(parentBranch);
  await assertCleanReviewWorktree(command, workspaceDirectory, signal);
  const [currentBranch, baselineCommit, repository] = await Promise.all([
    readCurrentReviewBranch(command, workspaceDirectory, signal),
    readReviewHeadCommit(command, workspaceDirectory, signal),
    resolveReviewRepository(command, workspaceDirectory, signal),
  ]);
  if (currentBranch !== parsedParent) {
    throw new ChangeReviewPublicationError(
      `Текущая Git-ветка изменилась с «${parsedParent}» на «${currentBranch}»`,
    );
  }

  const remoteParent = await readRemoteReviewBranchCommit(
    command,
    workspaceDirectory,
    parsedParent,
    signal,
  );
  if (remoteParent !== baselineCommit) {
    throw new ChangeReviewPublicationError(
      `Git remote origin не содержит текущий HEAD ветки «${parsedParent}»`,
    );
  }

  const parentPullRequests = await listReviewPullRequests(
    command,
    workspaceDirectory,
    repositoryArgument(repository),
    parsedParent,
    "open",
    signal,
  );
  if (parentPullRequests.length !== 1) {
    throw new ChangeReviewPublicationError(
      `Для предыдущей ветки «${parsedParent}» должен существовать ровно один открытый pull request`,
    );
  }
  const parentPullRequest = parentPullRequests[0]!;
  assertPullRequestRepository(parentPullRequest, repository.url);
  assertParentPullRequest(parentPullRequest, parsedParent, baselineCommit);

  const reviewBranch = deriveReviewBranch(parsedParent);
  if (
    (await readLocalReviewBranchCommit(
      command,
      workspaceDirectory,
      reviewBranch,
      signal,
    )) !== null
  ) {
    throw new ChangeReviewPublicationError(
      `Локальная review-ветка «${reviewBranch}» уже существует`,
    );
  }
  if (
    (await readOptionalRemoteReviewBranchCommit(
      command,
      workspaceDirectory,
      reviewBranch,
      signal,
    )) !== null
  ) {
    throw new ChangeReviewPublicationError(
      `Review-ветка «${reviewBranch}» уже существует в Git remote origin`,
    );
  }
  const previousReviewPullRequests = await listReviewPullRequests(
    command,
    workspaceDirectory,
    repositoryArgument(repository),
    reviewBranch,
    "all",
    signal,
  );
  if (previousReviewPullRequests.length > 0) {
    throw new ChangeReviewPublicationError(
      `Для review-ветки «${reviewBranch}» уже существует pull request`,
    );
  }

  return reviewPublicationTargetSchema.parse({
    parentBranch: parsedParent,
    reviewBranch,
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
  await assertCleanReviewWorktree(command, workspaceDirectory, signal);
  await assertParentPublication(command, workspaceDirectory, target, signal);

  const currentBranch = await readCurrentReviewBranch(
    command,
    workspaceDirectory,
    signal,
  );
  if (currentBranch !== target.parentBranch && currentBranch !== target.reviewBranch) {
    throw new ChangeReviewPublicationError(
      `Для восстановления review требуется ветка «${target.parentBranch}» или «${target.reviewBranch}», активна «${currentBranch}»`,
    );
  }

  const localReviewHead = await readLocalReviewBranchCommit(
    command,
    workspaceDirectory,
    target.reviewBranch,
    signal,
  );
  if (currentBranch === target.reviewBranch && localReviewHead === null) {
    throw new ChangeReviewPublicationError(
      "Активная review-ветка отсутствует среди локальных refs",
    );
  }
  if (localReviewHead !== null) {
    await assertReviewCommitDescendsFrom(
      command,
      workspaceDirectory,
      target.baselineCommit,
      localReviewHead,
      "Review-ветка больше не продолжает baseline предыдущей ветки",
      signal,
    );
  }

  const remoteReviewHead = await readOptionalRemoteReviewBranchCommit(
    command,
    workspaceDirectory,
    target.reviewBranch,
    signal,
  );
  if (
    currentBranch === target.parentBranch &&
    (localReviewHead !== null || remoteReviewHead !== null)
  ) {
    throw new ChangeReviewPublicationError(
      "Сохранённая review-ветка существует, но не является текущей; автоматическое переключение запрещено",
    );
  }
  if (
    remoteReviewHead !== null &&
    remoteReviewHead !== target.baselineCommit &&
    remoteReviewHead !== localReviewHead
  ) {
    throw new ChangeReviewPublicationError(
      `Git remote origin содержит неожиданное состояние review-ветки «${target.reviewBranch}»`,
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
      `Для review-ветки «${target.reviewBranch}» найдено несколько открытых pull request`,
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
    if (
      pullRequest.state !== "OPEN" ||
      pullRequest.isDraft ||
      pullRequest.isCrossRepository ||
      pullRequest.headRefName !== target.reviewBranch ||
      pullRequest.baseRefName !== target.parentBranch ||
      pullRequest.headRefOid !== remoteReviewHead ||
      pullRequest.title !== reviewPullRequestTitle(changeId) ||
      pullRequest.body !== reviewPullRequestBody(changeId)
    ) {
      throw new ChangeReviewPublicationError(
        "Существующий review pull request не соответствует сохранённой Ready-публикации",
      );
    }
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
        "Созданный review pull request больше не открыт; автоматическое создание замены запрещено",
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
  await assertParentPublication(command, workspaceDirectory, target, signal);

  const currentBranch = await readCurrentReviewBranch(
    command,
    workspaceDirectory,
    signal,
  );
  if (currentBranch !== target.reviewBranch) {
    throw new ChangeReviewPublicationError(
      `Текущая Git-ветка должна быть review-веткой «${target.reviewBranch}»`,
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
      `Git remote origin не содержит текущий HEAD review-ветки «${target.reviewBranch}»`,
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
      `Для review-ветки «${target.reviewBranch}» должен существовать ровно один открытый pull request`,
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
  if (pullRequest.state !== "OPEN") {
    throw new ChangeReviewPublicationError("Review pull request должен быть открыт");
  }
  if (pullRequest.isDraft) {
    throw new ChangeReviewPublicationError("Review pull request должен быть Ready");
  }
  if (pullRequest.isCrossRepository) {
    throw new ChangeReviewPublicationError(
      "Review pull request должен использовать ветку из origin",
    );
  }
  if (
    pullRequest.baseRefName !== target.parentBranch ||
    pullRequest.headRefName !== target.reviewBranch ||
    pullRequest.headRefOid !== head
  ) {
    throw new ChangeReviewPublicationError(
      "Review pull request не соответствует сохранённым base/head refs",
    );
  }
  const expectedTitle = reviewPullRequestTitle(changeId);
  const expectedBody = reviewPullRequestBody(changeId);
  if (pullRequest.title !== expectedTitle || pullRequest.body !== expectedBody) {
    throw new ChangeReviewPublicationError(
      "Название или описание review pull request не совпадает с ожидаемым содержимым",
    );
  }

  return {
    number: pullRequest.number,
    url: pullRequest.url,
    title: pullRequest.title,
  };
}

function deriveReviewBranch(parentBranch: string): string {
  const parsedParent = parseReviewBranch(parentBranch);
  const parsedReview = reviewBranchSchema.safeParse(
    `${parsedParent}${REVIEW_BRANCH_SUFFIX}`,
  );
  if (!parsedReview.success) {
    throw new ChangeReviewPublicationError(
      `Не удалось получить безопасное имя review-ветки из «${parsedParent}»`,
    );
  }
  return parsedReview.data;
}

async function assertParentPublication(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  target: ReviewPublicationTarget,
  signal?: AbortSignal,
): Promise<void> {
  const repository = await resolveReviewRepository(
    command,
    workspaceDirectory,
    signal,
  );
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
    readLocalReviewBranchCommit(
      command,
      workspaceDirectory,
      target.parentBranch,
      signal,
    ),
    readRemoteReviewBranchCommit(
      command,
      workspaceDirectory,
      target.parentBranch,
      signal,
    ),
  ]);
  if (
    localParent !== target.baselineCommit ||
    remoteParent !== target.baselineCommit
  ) {
    throw new ChangeReviewPublicationError(
      `Предыдущая ветка «${target.parentBranch}» изменилась после начала review`,
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
      "Открытый pull request предыдущей ветки изменился после начала review",
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
    target.baselineCommit,
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
      `Pull request предыдущей ветки должен быть открыт из «${parentBranch}» в «${REVIEW_PARENT_BRANCH}» и содержать её текущий HEAD`,
    );
  }
}

function targetRepositoryArgument(target: ReviewPublicationTarget): string {
  return repositoryArgument({
    host: target.repositoryHost,
    nameWithOwner: target.repositoryNameWithOwner,
  });
}
