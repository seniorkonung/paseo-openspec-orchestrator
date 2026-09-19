import { z } from "zod";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  ChangeReviewReportError,
  readChangeReviewReport,
  reviewFindingIdSchema,
  type ReviewFindingId,
} from "./change-review-report.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import { implementationBranchSchema, planningBranchSchema } from "./change-branch.ts";
import {
  ReviewFindingResolutionError,
  buildFindingResolutionPrompt,
  createReviewFindingResolutionService,
  type CompletedReviewFindingResolution,
  type ReviewFindingPromptInput,
  type ReviewFindingResolutionPaseoAgentCreator,
  type ReviewFindingResolutionPlan,
  type ReviewFindingResolutionRequest,
  type ReviewFindingResolutionService,
  type ReviewFindingResolutionServiceOptions,
  type ReviewFindingResolutionSession,
} from "./review-finding-resolution.ts";

const REVIEW_FILE_NAME = "review.md";

export interface PendingFindingResolutionSession
  extends ReviewFindingResolutionSession {}

export const pendingFindingResolutionSessionSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    branch: z.union([planningBranchSchema, implementationBranchSchema]),
    findingId: reviewFindingIdSchema,
    baselineCommit: commitHashSchema,
  })
  .strict();

export type ChangeFindingResolutionPlan =
  ReviewFindingResolutionPlan<PendingFindingResolutionSession>;
export type CompletedFindingResolution = CompletedReviewFindingResolution;
export type ChangeFindingResolutionRequest =
  ReviewFindingResolutionRequest<PendingFindingResolutionSession>;
export type ChangeFindingResolutionService =
  ReviewFindingResolutionService<PendingFindingResolutionSession>;
export type FindingResolutionPaseoAgentCreator =
  ReviewFindingResolutionPaseoAgentCreator;
export type ChangeFindingResolutionServiceOptions =
  ReviewFindingResolutionServiceOptions;

export { ReviewFindingResolutionError as ChangeFindingResolutionError };

export function createChangeFindingResolutionService(
  options: ChangeFindingResolutionServiceOptions,
): ChangeFindingResolutionService {
  return createReviewFindingResolutionService(options, {
    sessionSchema: pendingFindingResolutionSessionSchema,
    report: {
      fileName: REVIEW_FILE_NAME,
      missingMeansNoFindings: true,
      read: async (location) => {
        try {
          return await readChangeReviewReport(location);
        } catch (error) {
          if (error instanceof ChangeReviewReportError) {
            throw new ReviewFindingResolutionError(error.message);
          }
          throw new ReviewFindingResolutionError(
            "Не удалось разобрать review.md выбранного change",
          );
        }
      },
    },
    agent: {
      toolName: "complete_review_finding",
      toolDescription:
        "Проверить устранение и Git-публикацию finding, затем опубликовать её итог в review PR",
      title: (findingId) => `Устранение review finding: ${findingId}`,
      logLabel: "review finding",
      completionLabel: "Finding",
      prompt: changeFindingResolutionPrompt,
    },
    publication: {
      kind: "review",
      commitSubject: findingResolutionCommitSubject,
    },
  });
}

export function findingResolutionCommitSubject(findingId: ReviewFindingId): string {
  const normalizedFindingId = reviewFindingIdSchema.parse(findingId);
  return `docs(openspec): resolve ${normalizedFindingId} review finding`;
}

export function changeFindingResolutionPrompt(
  input: ReviewFindingPromptInput,
): string {
  return buildFindingResolutionPrompt(
    {
      reviewName: "an OpenSpec change review",
      skill: "openspec-review-change",
      toolName: "complete_review_finding",
      commitSubject: findingResolutionCommitSubject,
    },
    input,
  );
}
