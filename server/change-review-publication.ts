import { z } from "zod";
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";

const REVIEW_REMOTE = "origin";
const PARENT_BASE_BRANCH = "main";
const REVIEW_BRANCH_SUFFIX = "-review";
const MAX_BRANCH_LENGTH = 512;
const MAX_PR_TITLE_LENGTH = 256;
const MAX_PR_BODY_LENGTH = 65_536;
const MAX_URL_LENGTH = 2_048;
const MAX_OPEN_PULL_REQUESTS = 100;
const FALLBACK_REVIEW_PR_TITLE = "Первичное ревью OpenSpec change";

export const reviewBranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_BRANCH_LENGTH)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u,
    "Имя Git-ветки содержит небезопасные символы",
  )
  .refine(
    (value) =>
      value !== "@" &&
      value !== PARENT_BASE_BRANCH &&
      !value.includes("..") &&
      !value.includes("//") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")),
    "Для review требуется безопасное имя non-main Git-ветки",
  );

const githubHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u,
    "Ожидалось безопасное доменное имя GitHub host",
  );

const repositoryNameWithOwnerSchema = z
  .string()
  .trim()
  .min(3)
  .max(512)
  .regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    "Ожидалось имя GitHub-репозитория в формате owner/name",
  );

const httpsUrlSchema = z
  .string()
  .url()
  .max(MAX_URL_LENGTH)
  .refine((value) => new URL(value).protocol === "https:", "Ожидался HTTPS URL");

const pullRequestNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const repositorySchema = z
  .object({
    nameWithOwner: repositoryNameWithOwnerSchema,
    url: httpsUrlSchema,
  })
  .strict();

const pullRequestSchema = z
  .object({
    number: pullRequestNumberSchema,
    url: httpsUrlSchema,
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    isDraft: z.boolean(),
    isCrossRepository: z.boolean(),
    baseRefName: reviewBranchSchema.or(z.literal(PARENT_BASE_BRANCH)),
    headRefName: reviewBranchSchema,
    headRefOid: commitHashSchema,
    title: z.string().max(MAX_PR_TITLE_LENGTH),
    body: z.string().max(MAX_PR_BODY_LENGTH),
  })
  .strict();

const pullRequestListSchema = z.array(pullRequestSchema).max(MAX_OPEN_PULL_REQUESTS);

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

interface GitHubRemoteIdentity {
  readonly host: string;
  readonly nameWithOwner: string;
}

interface ResolvedRepository extends GitHubRemoteIdentity {
  readonly url: string;
}

export class ChangeReviewPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeReviewPublicationError";
  }
}

export async function prepareReviewPublication(
  workspaceDirectory: string,
  parentBranch: string,
  signal?: AbortSignal,
  command: BoundedCommandRunner = runBoundedCommand,
): Promise<ReviewPublicationTarget> {
  const parsedParent = parseBranch(parentBranch);
  await assertCleanWorktree(command, workspaceDirectory, signal);
  const [currentBranch, baselineCommit, repository] = await Promise.all([
    readCurrentBranch(command, workspaceDirectory, signal),
    readHeadCommit(command, workspaceDirectory, signal),
    resolveRepository(command, workspaceDirectory, signal),
  ]);
  if (currentBranch !== parsedParent) {
    throw new ChangeReviewPublicationError(
      `Текущая Git-ветка изменилась с «${parsedParent}» на «${currentBranch}»`,
    );
  }

  const remoteParent = await readRemoteCommit(
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

  const parentPullRequests = await listPullRequests(
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
  if ((await readLocalBranchCommit(command, workspaceDirectory, reviewBranch, signal)) !== null) {
    throw new ChangeReviewPublicationError(
      `Локальная review-ветка «${reviewBranch}» уже существует`,
    );
  }
  if ((await readOptionalRemoteCommit(command, workspaceDirectory, reviewBranch, signal)) !== null) {
    throw new ChangeReviewPublicationError(
      `Review-ветка «${reviewBranch}» уже существует в Git remote origin`,
    );
  }
  const previousReviewPullRequests = await listPullRequests(
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
  await assertCleanWorktree(command, workspaceDirectory, signal);
  await assertParentPublication(command, workspaceDirectory, target, signal);

  const currentBranch = await readCurrentBranch(command, workspaceDirectory, signal);
  if (currentBranch !== target.parentBranch && currentBranch !== target.reviewBranch) {
    throw new ChangeReviewPublicationError(
      `Для восстановления review требуется ветка «${target.parentBranch}» или «${target.reviewBranch}», активна «${currentBranch}»`,
    );
  }

  const localReviewHead = await readLocalBranchCommit(
    command,
    workspaceDirectory,
    target.reviewBranch,
    signal,
  );
  if (currentBranch === target.reviewBranch && localReviewHead === null) {
    throw new ChangeReviewPublicationError("Активная review-ветка отсутствует среди локальных refs");
  }
  if (localReviewHead !== null) {
    await assertDescendsFrom(
      command,
      workspaceDirectory,
      target.baselineCommit,
      localReviewHead,
      "Review-ветка больше не продолжает baseline предыдущей ветки",
      signal,
    );
  }

  const remoteReviewHead = await readOptionalRemoteCommit(
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

  const openReviewPullRequests = await listPullRequests(
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
    const pullRequest = await readPullRequest(
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
    const previousPullRequests = await listPullRequests(
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

  const currentBranch = await readCurrentBranch(command, workspaceDirectory, signal);
  if (currentBranch !== target.reviewBranch) {
    throw new ChangeReviewPublicationError(
      `Текущая Git-ветка должна быть review-веткой «${target.reviewBranch}»`,
    );
  }
  const remoteHead = await readRemoteCommit(
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

  const openPullRequests = await listPullRequests(
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
  const pullRequest = await readPullRequest(
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

export function reviewPullRequestTitle(changeIdInput: string): string {
  const changeId = openSpecChangeIdSchema.parse(changeIdInput);
  const detailed = `Первичное ревью OpenSpec change «${changeId}»`;
  return detailed.length <= MAX_PR_TITLE_LENGTH ? detailed : FALLBACK_REVIEW_PR_TITLE;
}

export function reviewPullRequestBody(changeIdInput: string): string {
  const changeId = openSpecChangeIdSchema.parse(changeIdInput);
  return `Первичное ревью артефактов OpenSpec change \`${changeId}\`.`;
}

function deriveReviewBranch(parentBranch: string): string {
  const parsedParent = parseBranch(parentBranch);
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
  const repository = await resolveRepository(command, workspaceDirectory, signal);
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
    readLocalBranchCommit(command, workspaceDirectory, target.parentBranch, signal),
    readRemoteCommit(command, workspaceDirectory, target.parentBranch, signal),
  ]);
  if (
    localParent !== target.baselineCommit ||
    remoteParent !== target.baselineCommit
  ) {
    throw new ChangeReviewPublicationError(
      `Предыдущая ветка «${target.parentBranch}» изменилась после начала review`,
    );
  }

  const openParentPullRequests = await listPullRequests(
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
  const parentPullRequest = await readPullRequest(
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
  pullRequest: z.output<typeof pullRequestSchema>,
  parentBranch: string,
  baselineCommit: string,
): void {
  if (
    pullRequest.state !== "OPEN" ||
    pullRequest.isCrossRepository ||
    pullRequest.baseRefName !== PARENT_BASE_BRANCH ||
    pullRequest.headRefName !== parentBranch ||
    pullRequest.headRefOid !== baselineCommit
  ) {
    throw new ChangeReviewPublicationError(
      `Pull request предыдущей ветки должен быть открыт из «${parentBranch}» в «${PARENT_BASE_BRANCH}» и содержать её текущий HEAD`,
    );
  }
}

async function resolveRepository(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<ResolvedRepository> {
  let originUrl: string;
  try {
    const result = await command("git", ["remote", "get-url", REVIEW_REMOTE], {
      cwd: workspaceDirectory,
      signal,
    });
    originUrl = result.stdout.trim();
    if (!originUrl) throw new Error("Пустой URL origin");
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      "Git remote origin отсутствует или недоступен",
    );
  }

  const remote = parseGitHubRemote(originUrl);
  try {
    await command("gh", ["auth", "status", "--hostname", remote.host], {
      cwd: workspaceDirectory,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `GitHub CLI недоступен или не авторизован для origin host «${remote.host}»`,
    );
  }

  const argument = repositoryArgument(remote);
  let repository: z.output<typeof repositorySchema>;
  try {
    const result = await command(
      "gh",
      ["repo", "view", argument, "--json", "nameWithOwner,url"],
      { cwd: workspaceDirectory, signal },
    );
    repository = repositorySchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      "Git remote origin не разрешается в доступный GitHub-репозиторий",
    );
  }
  if (
    new URL(repository.url).hostname.toLowerCase() !== remote.host ||
    repository.nameWithOwner.toLowerCase() !== remote.nameWithOwner.toLowerCase()
  ) {
    throw new ChangeReviewPublicationError(
      "GitHub CLI разрешил другой репозиторий вместо Git remote origin",
    );
  }
  return { ...remote, url: repository.url };
}

async function listPullRequests(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repository: string,
  branch: string,
  state: "open" | "all",
  signal?: AbortSignal,
): Promise<readonly z.output<typeof pullRequestSchema>[]> {
  try {
    // Официальный gh CLI поддерживает фильтр --head и ограниченный --json output:
    // https://cli.github.com/manual/gh_pr_list
    const result = await command(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--head",
        branch,
        "--state",
        state,
        "--limit",
        String(MAX_OPEN_PULL_REQUESTS),
        "--json",
        "number,url,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,title,body",
      ],
      { cwd: workspaceDirectory, signal },
    );
    return pullRequestListSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    if (error instanceof ChangeReviewPublicationError || signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `Не удалось получить pull request ветки «${branch}»`,
    );
  }
}

async function readPullRequest(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repository: string,
  number: number,
  signal?: AbortSignal,
): Promise<z.output<typeof pullRequestSchema>> {
  try {
    const result = await command(
      "gh",
      [
        "pr",
        "view",
        String(number),
        "--repo",
        repository,
        "--json",
        "number,url,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,title,body",
      ],
      { cwd: workspaceDirectory, signal },
    );
    return pullRequestSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `Не удалось прочитать pull request #${number}`,
    );
  }
}

async function assertCleanWorktree(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await command(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: workspaceDirectory, signal },
    );
    if (result.stdout.length > 0) {
      throw new ChangeReviewPublicationError(
        "Рабочее дерево Git содержит незакоммиченные или неотслеживаемые изменения",
      );
    }
  } catch (error) {
    if (error instanceof ChangeReviewPublicationError || signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      "Не удалось проверить чистоту рабочего дерева Git",
    );
  }
}

async function readCurrentBranch(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["branch", "--show-current"], {
      cwd: workspaceDirectory,
      signal,
    });
    return reviewBranchSchema.parse(result.stdout);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError("Не удалось подтвердить текущую Git-ветку");
  }
}

async function readHeadCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["rev-parse", "HEAD"], {
      cwd: workspaceDirectory,
      signal,
    });
    return commitHashSchema.parse(result.stdout.trim());
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError("Не удалось определить текущий Git HEAD");
  }
}

async function readLocalBranchCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const ref = `refs/heads/${parseBranch(branch)}`;
  try {
    const result = await command(
      "git",
      ["for-each-ref", "--format=%(objectname)%00%(refname)", ref],
      { cwd: workspaceDirectory, signal },
    );
    if (result.stdout.length === 0) return null;
    const [hash, reportedRef, extra] = result.stdout.trimEnd().split("\0");
    if (extra !== undefined || reportedRef !== ref) {
      throw new Error("Некорректный local ref");
    }
    return commitHashSchema.parse(hash);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `Не удалось прочитать локальную ветку «${branch}»`,
    );
  }
}

async function readRemoteCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string> {
  const commit = await readOptionalRemoteCommit(
    command,
    workspaceDirectory,
    branch,
    signal,
  );
  if (commit === null) {
    throw new ChangeReviewPublicationError(
      `Ветка «${branch}» отсутствует в Git remote origin`,
    );
  }
  return commit;
}

async function readOptionalRemoteCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const parsedBranch = parseBranch(branch);
  const ref = `refs/heads/${parsedBranch}`;
  try {
    const result = await command(
      "git",
      ["ls-remote", "--heads", REVIEW_REMOTE, ref],
      { cwd: workspaceDirectory, signal },
    );
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    if (lines.length !== 1) throw new Error("Неоднозначный remote ref");
    const [hash, reportedRef, extra] = lines[0]!.split("\t");
    if (extra !== undefined || reportedRef !== ref) {
      throw new Error("Некорректный remote ref");
    }
    return commitHashSchema.parse(hash);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `Не удалось прочитать ветку «${parsedBranch}» в Git remote origin`,
    );
  }
}

async function assertDescendsFrom(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  ancestor: string,
  descendant: string,
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await command("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: workspaceDirectory,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(message);
  }
}

function assertPullRequestRepository(
  pullRequest: { readonly number: number; readonly url: string },
  repositoryUrl: string,
): void {
  const expectedUrl = `${repositoryUrl.replace(/\/$/u, "")}/pull/${pullRequest.number}`;
  if (pullRequest.url !== expectedUrl) {
    throw new ChangeReviewPublicationError(
      `Pull request #${pullRequest.number} принадлежит другому GitHub-репозиторию`,
    );
  }
}

function parseGitHubRemote(remoteUrl: string): GitHubRemoteIdentity {
  let host: string;
  let repositoryPath: string;
  try {
    const url = new URL(remoteUrl);
    if (!["https:", "ssh:"].includes(url.protocol) || !url.hostname) {
      throw new Error("Неподдерживаемый URL");
    }
    host = githubHostSchema.parse(url.hostname);
    repositoryPath = url.pathname.replace(/^\/+|\/+$/gu, "");
  } catch {
    const match = /^(?:[^@\s]+@)?([^:/\s]+):([^\s]+)$/u.exec(remoteUrl);
    if (!match?.[1] || !match[2]) {
      throw new ChangeReviewPublicationError(
        "Git remote origin должен указывать на GitHub",
      );
    }
    const parsedHost = githubHostSchema.safeParse(match[1]);
    if (!parsedHost.success) {
      throw new ChangeReviewPublicationError(
        "Git remote origin содержит недопустимый host",
      );
    }
    host = parsedHost.data;
    repositoryPath = match[2].replace(/^\/+|\/+$/gu, "");
  }

  const nameWithOwner = repositoryNameWithOwnerSchema.safeParse(
    repositoryPath.replace(/\.git$/u, ""),
  );
  if (!nameWithOwner.success) {
    throw new ChangeReviewPublicationError(
      "Git remote origin должен указывать на GitHub-репозиторий owner/name",
    );
  }
  return { host, nameWithOwner: nameWithOwner.data };
}

function repositoryArgument(repository: GitHubRemoteIdentity): string {
  return repository.host === "github.com"
    ? repository.nameWithOwner
    : `${repository.host}/${repository.nameWithOwner}`;
}

function targetRepositoryArgument(target: ReviewPublicationTarget): string {
  return repositoryArgument({
    host: target.repositoryHost,
    nameWithOwner: target.repositoryNameWithOwner,
  });
}

function parseBranch(branch: string): string {
  const parsed = reviewBranchSchema.safeParse(branch);
  if (!parsed.success) {
    throw new ChangeReviewPublicationError(
      "Для review требуется безопасное имя non-main Git-ветки",
    );
  }
  return parsed.data;
}
