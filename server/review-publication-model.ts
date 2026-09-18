import { z } from "zod";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  githubHostSchema,
  repositoryNameWithOwnerSchema,
  type GitHubRemoteIdentity,
} from "./github-repository-identity.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";

export {
  githubHostSchema,
  repositoryNameWithOwnerSchema,
} from "./github-repository-identity.ts";

export const REVIEW_REMOTE = "origin";
export const REVIEW_PARENT_BRANCH = "main";
export const REVIEW_BRANCH_SUFFIX = "-review";
export const MAX_REVIEW_PR_TITLE_LENGTH = 256;
export const MAX_REVIEW_PR_BODY_LENGTH = 65_536;

const MAX_BRANCH_LENGTH = 512;
const MAX_URL_LENGTH = 2_048;
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
      value !== REVIEW_PARENT_BRANCH &&
      !value.includes("..") &&
      !value.includes("//") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")),
    "Для review требуется безопасное имя non-main Git-ветки",
  );

export const httpsUrlSchema = z
  .string()
  .url()
  .max(MAX_URL_LENGTH)
  .refine((value) => new URL(value).protocol === "https:", "Ожидался HTTPS URL");

export const pullRequestNumberSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const reviewRepositorySchema = z
  .object({
    nameWithOwner: repositoryNameWithOwnerSchema,
    url: httpsUrlSchema,
  })
  .strict();

export const reviewPullRequestSchema = z
  .object({
    number: pullRequestNumberSchema,
    url: httpsUrlSchema,
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    isDraft: z.boolean(),
    isCrossRepository: z.boolean(),
    baseRefName: reviewBranchSchema.or(z.literal(REVIEW_PARENT_BRANCH)),
    headRefName: reviewBranchSchema,
    headRefOid: commitHashSchema,
    title: z.string().max(MAX_REVIEW_PR_TITLE_LENGTH),
    body: z.string().max(MAX_REVIEW_PR_BODY_LENGTH),
  })
  .strict();

export type ReviewPullRequest = z.output<typeof reviewPullRequestSchema>;

export interface ResolvedReviewRepository extends GitHubRemoteIdentity {
  readonly url: string;
}

export class ChangeReviewPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeReviewPublicationError";
  }
}

export function reviewPullRequestTitle(changeIdInput: string): string {
  const changeId = openSpecChangeIdSchema.parse(changeIdInput);
  const detailed = `Первичное ревью OpenSpec change «${changeId}»`;
  return detailed.length <= MAX_REVIEW_PR_TITLE_LENGTH
    ? detailed
    : FALLBACK_REVIEW_PR_TITLE;
}

export function reviewPullRequestBody(changeIdInput: string): string {
  const changeId = openSpecChangeIdSchema.parse(changeIdInput);
  return `Первичное ревью артефактов OpenSpec change \`${changeId}\`.`;
}

export function parseReviewBranch(branch: string): string {
  const parsed = reviewBranchSchema.safeParse(branch);
  if (!parsed.success) {
    throw new ChangeReviewPublicationError(
      "Для review требуется безопасное имя non-main Git-ветки",
    );
  }
  return parsed.data;
}

export function repositoryArgument(repository: GitHubRemoteIdentity): string {
  return repository.host === "github.com"
    ? repository.nameWithOwner
    : `${repository.host}/${repository.nameWithOwner}`;
}

export function assertPullRequestRepository(
  pullRequest: Pick<ReviewPullRequest, "number" | "url">,
  repositoryUrl: string,
): void {
  const expectedUrl = `${repositoryUrl.replace(/\/$/u, "")}/pull/${pullRequest.number}`;
  if (pullRequest.url !== expectedUrl) {
    throw new ChangeReviewPublicationError(
      `Pull request #${pullRequest.number} принадлежит другому GitHub-репозиторию`,
    );
  }
}
