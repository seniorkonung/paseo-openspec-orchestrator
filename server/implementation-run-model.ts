import { z } from "zod";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  changeBranchFor,
  changeBranchSchema,
  implementationBranchForRun,
  implementationBranchSchema,
} from "./change-branch.ts";
import {
  githubHostSchema,
  repositoryNameWithOwnerSchema,
} from "./github-repository-identity.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  httpsUrlSchema,
  pullRequestNumberSchema,
} from "./review-publication-model.ts";
import {
  taskIdSchema,
  taskNumberSchema,
} from "./change-task-model.ts";

export const MAX_PROCESSED_FEEDBACK_FINGERPRINTS = 4_096;
export const MAX_IMPLEMENTATION_BATCH_TASKS = 4_096;

export const implementationRepositorySchema = z
  .object({
    host: githubHostSchema,
    nameWithOwner: repositoryNameWithOwnerSchema,
    url: httpsUrlSchema,
  })
  .strict();

export const implementationTaskCommitSchema = z
  .object({
    taskId: taskIdSchema,
    taskNumber: taskNumberSchema,
    commit: commitHashSchema,
  })
  .strict();

const nonEmptyTaskCommitsSchema = z
  .array(implementationTaskCommitSchema)
  .min(1)
  .max(MAX_IMPLEMENTATION_BATCH_TASKS)
  .superRefine((tasks, context) => {
    for (const key of ["taskId", "taskNumber", "commit"] as const) {
      if (new Set(tasks.map((task) => task[key])).size !== tasks.length) {
        context.addIssue({
          code: "custom",
          message: `Пакет implementation содержит повторяющийся ${key}`,
        });
      }
    }
  });

export const implementationBatchSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("empty"),
      baseCommit: commitHashSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("collecting"),
      baseCommit: commitHashSchema,
      headCommit: commitHashSchema,
      tasks: nonEmptyTaskCommitsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reviewed"),
      baseCommit: commitHashSchema,
      headCommit: commitHashSchema,
      reviewCommit: commitHashSchema,
      tasks: nonEmptyTaskCommitsSchema,
    })
    .strict(),
]);

const implementationPullRequestPublicationSchema = z
  .object({
    number: pullRequestNumberSchema,
    url: httpsUrlSchema,
    title: z.string().trim().min(1).max(256),
  })
  .strict();

export const implementationPublicationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unpublished") }).strict(),
  implementationPullRequestPublicationSchema.extend({ kind: z.literal("draft-pr") }),
  implementationPullRequestPublicationSchema.extend({ kind: z.literal("ready-pr") }),
]);

export const feedbackFingerprintSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "Fingerprint feedback должен быть SHA-256");

export const implementationRunSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    changeBranch: changeBranchSchema,
    implementationBranch: implementationBranchSchema,
    phaseNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
    runNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
    rootBaselineCommit: commitHashSchema,
    repository: implementationRepositorySchema,
    publication: implementationPublicationSchema,
    batch: implementationBatchSchema,
    lastDeliveryHead: commitHashSchema.nullable(),
    processedFeedbackFingerprints: z
      .array(feedbackFingerprintSchema)
      .max(MAX_PROCESSED_FEEDBACK_FINGERPRINTS)
      .refine(
        (values) => new Set(values).size === values.length,
        "Обработанные fingerprints feedback не должны повторяться",
      ),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.changeBranch !== changeBranchFor(run.changeId)) {
      context.addIssue({
        code: "custom",
        path: ["changeBranch"],
        message: "Корневая ветка implementation-run не соответствует change",
      });
    }
    if (
      run.implementationBranch !==
        implementationBranchForRun(run.changeId, run.phaseNumber, run.runNumber)
    ) {
      context.addIssue({
        code: "custom",
        path: ["implementationBranch"],
        message: "Implementation-ветка не соответствует change",
      });
    }
    if (run.batch.kind !== "empty" && run.batch.baseCommit === run.batch.headCommit) {
      context.addIssue({
        code: "custom",
        path: ["batch", "headCommit"],
        message: "Непустой implementation-пакет должен продвигать Git HEAD",
      });
    }
    if (run.batch.kind === "reviewed" && run.lastDeliveryHead !== run.batch.headCommit) {
      context.addIssue({
        code: "custom",
        path: ["lastDeliveryHead"],
        message: "Reviewed-пакет должен быть последним проверенным delivery head",
      });
    }
    if (run.publication.kind !== "unpublished" && run.lastDeliveryHead === null) {
      context.addIssue({
        code: "custom",
        path: ["publication"],
        message: "Implementation PR нельзя опубликовать до успешного review",
      });
    }
    if (run.publication.kind === "unpublished" && run.lastDeliveryHead !== null) {
      context.addIssue({
        code: "custom",
        path: ["lastDeliveryHead"],
        message: "Неопубликованный implementation-run не может иметь delivery head",
      });
    }
    if (run.batch.kind === "reviewed" && run.publication.kind === "unpublished") {
      context.addIssue({
        code: "custom",
        path: ["publication"],
        message: "Reviewed-пакет должен иметь единый implementation PR",
      });
    }
    if (run.publication.kind === "ready-pr" && run.batch.kind !== "empty") {
      context.addIssue({
        code: "custom",
        path: ["publication"],
        message: "Ready implementation PR требует пустой task-пакет",
      });
    }
  });

export type ImplementationTaskCommit = z.infer<typeof implementationTaskCommitSchema>;
export type ImplementationBatch = z.infer<typeof implementationBatchSchema>;
export type ImplementationPublication = z.infer<typeof implementationPublicationSchema>;
export type ImplementationRun = z.infer<typeof implementationRunSchema>;

export function collectImplementationTask(
  runInput: ImplementationRun,
  task: ImplementationTaskCommit,
): ImplementationRun {
  const run = implementationRunSchema.parse(runInput);
  const parsedTask = implementationTaskCommitSchema.parse(task);
  if (run.batch.kind === "reviewed") {
    throw new Error("Нельзя добавлять task-коммит в уже проверенный пакет");
  }
  const tasks = run.batch.kind === "empty"
    ? [parsedTask]
    : [...run.batch.tasks, parsedTask];
  return implementationRunSchema.parse({
    ...run,
    batch: {
      kind: "collecting",
      baseCommit: run.batch.baseCommit,
      headCommit: parsedTask.commit,
      tasks,
    },
  });
}

export function clearImplementationBatch(
  runInput: ImplementationRun,
  baseCommit: string,
): ImplementationRun {
  const run = implementationRunSchema.parse(runInput);
  return implementationRunSchema.parse({
    ...run,
    batch: { kind: "empty", baseCommit: commitHashSchema.parse(baseCommit) },
  });
}
