import { z } from "zod";
import { commitHashSchema } from "./change-artifact-model.ts";
import { repositoryNameWithOwnerSchema } from "./github-repository-identity.ts";

export const PUBLICATION_REMOTE = "origin";
export const PUBLICATION_BASE_BRANCH = "main";
const MAX_BRANCH_LENGTH = 512;
const MAX_PR_TITLE_LENGTH = 256;
const MAX_PR_BODY_LENGTH = 65_536;
const MAX_URL_LENGTH = 2_048;
export const MAX_OPEN_PULL_REQUESTS = 100;

export const gitBranchNameSchema = z
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
      !value.includes("..") &&
      !value.includes("//") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")),
    "Имя Git-ветки не соответствует безопасному формату Git ref",
  );

export const publicationBranchSchema = gitBranchNameSchema.refine(
  (value) => value !== PUBLICATION_BASE_BRANCH,
  "Для публикации требуется non-main Git-ветка",
);

const pullRequestNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const pullRequestTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PR_TITLE_LENGTH)
  .regex(
    /^[\p{L}\p{N} .,:«»—–/_-]+$/u,
    "Название PR содержит небезопасные или нестабильные символы",
  );
const pullRequestBodySchema = z
  .string()
  .min(1)
  .max(MAX_PR_BODY_LENGTH)
  .refine((value) => value.trim().length > 0, "Описание PR не может быть пустым")
  .refine((value) => !value.includes("\0"), "Описание PR содержит недопустимый символ");
const httpsUrlSchema = z
  .string()
  .url()
  .max(MAX_URL_LENGTH)
  .refine((value) => new URL(value).protocol === "https:", "Ожидался HTTPS URL");

export const repositorySchema = z
  .object({
    nameWithOwner: repositoryNameWithOwnerSchema,
    url: httpsUrlSchema,
  })
  .strict();

export const pullRequestSchema = z
  .object({
    number: pullRequestNumberSchema,
    url: httpsUrlSchema,
    state: z.enum(["OPEN", "CLOSED", "MERGED"]).optional(),
    isDraft: z.boolean(),
    isCrossRepository: z.boolean(),
    baseRefName: gitBranchNameSchema,
    headRefName: gitBranchNameSchema,
    headRefOid: commitHashSchema,
    title: z.string().max(MAX_PR_TITLE_LENGTH),
    body: z.string().max(MAX_PR_BODY_LENGTH),
  })
  .strict();

export const openPullRequestSchema = z
  .object({
    number: pullRequestNumberSchema,
    url: httpsUrlSchema,
    isDraft: z.boolean(),
    isCrossRepository: z.boolean(),
    headRefName: gitBranchNameSchema,
  })
  .strict();

export const openPullRequestListSchema = z
  .array(openPullRequestSchema)
  .max(MAX_OPEN_PULL_REQUESTS);

export const publicationCompletionInputSchema = z
  .object({
    pullRequestNumber: pullRequestNumberSchema,
    title: pullRequestTitleSchema,
    body: pullRequestBodySchema,
  })
  .strict();

export const publicationCompletionOutputSchema = z
  .object({
    pullRequestNumber: pullRequestNumberSchema,
    url: httpsUrlSchema,
    title: pullRequestTitleSchema,
  })
  .strict();

export interface PublishedPullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
}

export interface PublicationTarget {
  readonly repository: string;
  readonly repositoryUrl: string;
  readonly expectedHead: string;
  readonly existingPullRequest: z.output<typeof openPullRequestSchema> | null;
}

export type PublicationCompletionInput = z.output<
  typeof publicationCompletionInputSchema
>;

export class ChangePublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangePublicationError";
  }
}
