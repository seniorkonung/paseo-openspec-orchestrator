import { z } from "zod";
import { commitHashSchema, schemaNameSchema } from "./change-artifact-model.ts";
import {
  githubHostSchema,
  repositoryNameWithOwnerSchema,
  type GitHubRemoteIdentity,
} from "./github-repository-identity.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";

export const TASK_REMOTE = "origin";
export const MAX_TASKS = 4_096;
export const MAX_TASK_DESCRIPTION_LENGTH = 4_096;
export const MAX_TASK_PR_TITLE_LENGTH = 256;
export const MAX_TASK_PR_BODY_LENGTH = 65_536;

const MAX_TASK_ID_LENGTH = 128;
const MAX_TASK_NUMBER_LENGTH = 128;
const MAX_BRANCH_LENGTH = 512;
const MAX_URL_LENGTH = 2_048;

export const taskIdSchema = z.string().trim().min(1).max(MAX_TASK_ID_LENGTH);
export const taskNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TASK_NUMBER_LENGTH)
  .regex(
    /^\d+(?:\.\d+)+(?:[A-Za-z]+)?$/u,
    "Номер OpenSpec-задачи должен иметь формат 1.1 или 1.1.1",
  );
export const taskDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TASK_DESCRIPTION_LENGTH);
export const taskDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const taskBranchSchema = z
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
      value !== "main" &&
      !value.includes("..") &&
      !value.includes("//") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")),
    "Для task-этапа требуется безопасное имя non-main Git-ветки",
  );

export const taskGithubHostSchema = githubHostSchema;
export const taskRepositoryNameWithOwnerSchema = repositoryNameWithOwnerSchema;
export const taskHttpsUrlSchema = z
  .string()
  .url()
  .max(MAX_URL_LENGTH)
  .refine((value) => new URL(value).protocol === "https:", "Ожидался HTTPS URL");
export const taskPullRequestNumberSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const taskPullRequestTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TASK_PR_TITLE_LENGTH)
  .regex(
    /^[\p{L}\p{N} .,:«»—–/_-]+$/u,
    "Название PR содержит небезопасные или нестабильные символы",
  );
export const taskPullRequestBodySchema = z
  .string()
  .min(1)
  .max(MAX_TASK_PR_BODY_LENGTH)
  .refine((value) => value.trim().length > 0, "Описание PR не может быть пустым")
  .refine((value) => !value.includes("\0"), "Описание PR содержит недопустимый символ");

export const applyTaskSchema = z
  .object({
    id: taskIdSchema,
    description: taskDescriptionSchema,
    done: z.boolean(),
  })
  .strict();

export const applyInstructionsSchema = z
  .object({
    changeName: openSpecChangeIdSchema,
    schemaName: schemaNameSchema,
    progress: z
      .object({
        total: z.number().int().nonnegative().max(MAX_TASKS),
        complete: z.number().int().nonnegative().max(MAX_TASKS),
        remaining: z.number().int().nonnegative().max(MAX_TASKS),
      })
      .strict(),
    tasks: z.array(applyTaskSchema).max(MAX_TASKS),
    state: z.enum(["blocked", "all_done", "ready"]),
    instruction: z.string().max(16_384),
  })
  .loose();

export const taskRepositorySchema = z
  .object({
    nameWithOwner: taskRepositoryNameWithOwnerSchema,
    url: taskHttpsUrlSchema,
  })
  .strict();

export const taskPullRequestSchema = z
  .object({
    number: taskPullRequestNumberSchema,
    url: taskHttpsUrlSchema,
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    isDraft: z.boolean(),
    isCrossRepository: z.boolean(),
    baseRefName: taskBranchSchema.or(z.literal("main")),
    headRefName: taskBranchSchema,
    headRefOid: commitHashSchema,
    title: z.string().max(MAX_TASK_PR_TITLE_LENGTH),
    body: z.string().max(MAX_TASK_PR_BODY_LENGTH),
  })
  .strict();

export const taskCompletionInputSchema = z
  .object({
    pullRequestNumber: taskPullRequestNumberSchema,
    title: taskPullRequestTitleSchema,
    body: taskPullRequestBodySchema,
  })
  .strict();

export const completedTaskPullRequestSchema = z
  .object({
    number: taskPullRequestNumberSchema,
    url: taskHttpsUrlSchema,
    title: taskPullRequestTitleSchema,
  })
  .strict();

export const pendingTaskExecutionSessionSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    schemaName: schemaNameSchema,
    taskId: taskIdSchema,
    taskNumber: taskNumberSchema,
    taskDescription: taskDescriptionSchema,
    parentBranch: taskBranchSchema,
    parentBaseBranch: taskBranchSchema.or(z.literal("main")),
    taskBranch: taskBranchSchema,
    baselineCommit: commitHashSchema,
    tasksBeforeDigest: taskDigestSchema,
    tasksAfterDigest: taskDigestSchema,
    progressTotal: z.number().int().positive().max(MAX_TASKS),
    progressComplete: z.number().int().nonnegative().max(MAX_TASKS),
    repositoryHost: taskGithubHostSchema,
    repositoryNameWithOwner: taskRepositoryNameWithOwnerSchema,
    repositoryUrl: taskHttpsUrlSchema,
    parentPullRequestNumber: taskPullRequestNumberSchema,
  })
  .strict()
  .superRefine((session, context) => {
    if (session.taskBranch !== `${session.changeId}-task-${session.taskNumber}`) {
      context.addIssue({
        code: "custom",
        path: ["taskBranch"],
        message: "Task-ветка не соответствует change и номеру задачи",
      });
    }
    if (session.progressComplete >= session.progressTotal) {
      context.addIssue({
        code: "custom",
        path: ["progressComplete"],
        message: "Pending task требует хотя бы одну незавершённую задачу",
      });
    }
  });

export type ApplyTask = z.output<typeof applyTaskSchema>;
export type ApplyInstructions = z.output<typeof applyInstructionsSchema>;
export type TaskCompletionInput = z.output<typeof taskCompletionInputSchema>;
export type TaskPullRequest = z.output<typeof taskPullRequestSchema>;
export type PendingTaskExecutionSession = z.infer<
  typeof pendingTaskExecutionSessionSchema
>;

export type ChangeTaskExecutionPlan =
  | {
      readonly kind: "complete";
      readonly schemaName: string;
    }
  | {
      readonly kind: "next-task";
      readonly session: PendingTaskExecutionSession;
    };

export interface CompletedTaskPullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
}

export interface CompletedChangeTask {
  readonly changeId: string;
  readonly taskNumber: string;
  readonly branch: string;
  readonly remainingTasks: number;
  readonly pullRequest: CompletedTaskPullRequest;
}

export type TaskGitHubRemoteIdentity = GitHubRemoteIdentity;

export interface ResolvedTaskRepository extends TaskGitHubRemoteIdentity {
  readonly url: string;
}

export class ChangeTaskExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeTaskExecutionError";
  }
}

export function parseTaskChangeId(changeId: string): string {
  const parsed = openSpecChangeIdSchema.safeParse(changeId);
  if (!parsed.success) {
    throw new ChangeTaskExecutionError("Change ID должен быть в kebab-case");
  }
  return parsed.data;
}

export function parseTaskBranch(branch: string): string {
  const parsed = taskBranchSchema.safeParse(branch);
  if (!parsed.success) {
    throw new ChangeTaskExecutionError(
      "Для task-этапа требуется безопасное имя non-main Git-ветки",
    );
  }
  return parsed.data;
}

export function taskRepositoryArgument(
  repository: TaskGitHubRemoteIdentity,
): string {
  return repository.host === "github.com"
    ? repository.nameWithOwner
    : `${repository.host}/${repository.nameWithOwner}`;
}

export function taskRepositoryFromSession(
  session: PendingTaskExecutionSession,
): ResolvedTaskRepository {
  return {
    host: session.repositoryHost,
    nameWithOwner: session.repositoryNameWithOwner,
    url: session.repositoryUrl,
  };
}
