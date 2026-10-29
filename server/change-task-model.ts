import { z } from "zod";
import { commitHashSchema, schemaNameSchema } from "./change-artifact-model.ts";
import {
  githubHostSchema,
  repositoryNameWithOwnerSchema,
  type GitHubRemoteIdentity,
} from "./github-repository-identity.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  ESCALATION_PROFILE,
  taskProfileNameSchema,
  taskProfileTextSchema,
  type TaskProfileName,
} from "./task-profile-level.ts";
import {
  changeBranchFor,
  changeBranchSchema,
  implementationBranchSchema,
  type ImplementationBranch,
} from "./change-branch.ts";

export const TASK_REMOTE = "origin";
export const MAX_TASKS = 4_096;
export const MAX_TASK_DESCRIPTION_LENGTH = 4_096;

const MAX_TASK_ID_LENGTH = 128;
const MAX_TASK_NUMBER_LENGTH = 128;
const MAX_BRANCH_LENGTH = 512;
const MAX_URL_LENGTH = 2_048;

/** Номер задачи в начале её описания: `1.1`, `1.1.2` или `1.1a`. */
export const TASK_NUMBER_PREFIX = /^(\d+(?:\.\d+)+(?:[A-Za-z]+)?)(?=\s|$)/u;

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

export const taskCompletionInputSchema = z.object({}).strict();

const taskExecutionSessionShape = {
  changeId: openSpecChangeIdSchema,
  schemaName: schemaNameSchema,
  taskId: taskIdSchema,
  taskNumber: taskNumberSchema,
  taskDescription: taskDescriptionSchema,
  phaseNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
  changeBranch: changeBranchSchema,
  implementationBranch: implementationBranchSchema,
  rootBaselineCommit: commitHashSchema,
  baselineCommit: commitHashSchema,
  tasksBeforeDigest: taskDigestSchema,
  tasksAfterDigest: taskDigestSchema,
  progressTotal: z.number().int().positive().max(MAX_TASKS),
  progressComplete: z.number().int().nonnegative().max(MAX_TASKS),
  repositoryHost: taskGithubHostSchema,
  repositoryNameWithOwner: taskRepositoryNameWithOwnerSchema,
  repositoryUrl: taskHttpsUrlSchema,
};

function refineTaskExecutionSession(
  session: {
    readonly changeId: string;
    readonly changeBranch: string;
    readonly implementationBranch: string;
    readonly progressTotal: number;
    readonly progressComplete: number;
  },
  context: z.RefinementCtx,
): void {
  if (session.changeBranch !== changeBranchFor(session.changeId)) {
    context.addIssue({
      code: "custom",
      path: ["changeBranch"],
      message: "Корневая ветка task-сессии не соответствует change",
    });
  }
  if (session.implementationBranch !== session.changeBranch) {
    context.addIssue({
      code: "custom",
      path: ["implementationBranch"],
      message: "Implementation-ветка task-сессии не соответствует change",
    });
  }
  if (session.progressComplete >= session.progressTotal) {
    context.addIssue({
      code: "custom",
      path: ["progressComplete"],
      message: "Pending task требует хотя бы одну незавершённую задачу",
    });
  }
}

/** Выбранная задача до назначения профиля агента. */
export const plannedTaskExecutionSessionSchema = z
  .object(taskExecutionSessionShape)
  .strict()
  .superRefine(refineTaskExecutionSession);

export const pendingTaskExecutionSessionSchema = z
  .object({
    ...taskExecutionSessionShape,
    /** Профиль агента задачи; checkpoint до появления профилей выполнялся на High. */
    profile: taskProfileNameSchema.default("High"),
    /** Почему задачу передали этому профилю после эскалации; `null` — без эскалации. */
    escalationReason: taskProfileTextSchema.nullable().default(null),
  })
  .strict()
  .superRefine((session, context) => {
    refineTaskExecutionSession(session, context);
    if (session.escalationReason !== null && session.profile !== ESCALATION_PROFILE) {
      context.addIssue({
        code: "custom",
        path: ["profile"],
        message: `После эскалации задачу выполняет профиль ${ESCALATION_PROFILE}`,
      });
    }
  });

export type ApplyTask = z.output<typeof applyTaskSchema>;
export type ApplyInstructions = z.output<typeof applyInstructionsSchema>;
export type TaskCompletionInput = z.output<typeof taskCompletionInputSchema>;
export type PlannedTaskExecutionSession = z.infer<
  typeof plannedTaskExecutionSessionSchema
>;
export type PendingTaskExecutionSession = z.infer<
  typeof pendingTaskExecutionSessionSchema
>;

/**
 * Профиль, которым выполняется выбранная задача. Причина эскалации есть,
 * только когда задачу передал агент более слабого профиля.
 */
export type TaskExecutionProfile =
  | { readonly profile: TaskProfileName; readonly escalationReason: null }
  | { readonly profile: typeof ESCALATION_PROFILE; readonly escalationReason: string };

export function assignTaskExecutionProfile(
  planned: PlannedTaskExecutionSession,
  assignment: TaskExecutionProfile,
): PendingTaskExecutionSession {
  return pendingTaskExecutionSessionSchema.parse({
    ...plannedTaskExecutionSessionSchema.parse(planned),
    profile: assignment.profile,
    escalationReason: assignment.escalationReason,
  });
}

export type ChangeTaskExecutionPlan =
  | {
      readonly kind: "complete";
      readonly schemaName: string;
      readonly reason?: "change-complete" | "phase-complete";
    }
  | {
      readonly kind: "next-task";
      readonly session: PlannedTaskExecutionSession;
    };

export interface CompletedChangeTask {
  readonly changeId: string;
  readonly taskId: string;
  readonly taskNumber: string;
  readonly branch: ImplementationBranch;
  readonly commit: string;
  readonly remainingTasks: number;
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
