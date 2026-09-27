import { z } from "zod";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  ImplementationReviewReportError,
  readImplementationReviewReport,
} from "./implementation-review-report.ts";
import {
  reviewFindingIdSchema,
} from "./change-review-report.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import { implementationBranchSchema, planningBranchSchema } from "./change-branch.ts";
import {
  ReviewFindingResolutionError,
  buildFindingResolutionPrompt,
  createReviewFindingResolutionService,
  type CompletedReviewFindingResolution,
  type ReviewFindingPromptInput,
  type ReviewFindingResolutionPlan,
  type ReviewFindingResolutionRequest,
  type ReviewFindingResolutionService,
  type ReviewFindingResolutionServiceOptions,
  type ReviewFindingResolutionSession,
} from "./review-finding-resolution.ts";

const IMPLEMENTATION_REVIEW_FILE_NAME = "implementation-review.md";

export interface PendingImplementationFindingResolutionSession
  extends ReviewFindingResolutionSession {}

export const pendingImplementationFindingResolutionSessionSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    branch: z.union([implementationBranchSchema, planningBranchSchema]),
    findingId: reviewFindingIdSchema,
    baselineCommit: commitHashSchema,
  })
  .strict();

export type ImplementationFindingResolutionPlan =
  ReviewFindingResolutionPlan<PendingImplementationFindingResolutionSession>;
export type CompletedImplementationFindingResolution =
  CompletedReviewFindingResolution;
export type ImplementationFindingResolutionRequest =
  ReviewFindingResolutionRequest<PendingImplementationFindingResolutionSession>;
export type ImplementationFindingResolutionService =
  ReviewFindingResolutionService<PendingImplementationFindingResolutionSession>;
export type ImplementationFindingResolutionServiceOptions =
  ReviewFindingResolutionServiceOptions;

export {
  ReviewFindingResolutionError as ImplementationFindingResolutionError,
};

export function createImplementationFindingResolutionService(
  options: ImplementationFindingResolutionServiceOptions,
): ImplementationFindingResolutionService {
  return createReviewFindingResolutionService(options, {
    sessionSchema: pendingImplementationFindingResolutionSessionSchema,
    report: {
      fileName: IMPLEMENTATION_REVIEW_FILE_NAME,
      missingMeansNoFindings: true,
      read: async (location) => {
        try {
          return await readImplementationReviewReport(location);
        } catch (error) {
          if (error instanceof ImplementationReviewReportError) {
            throw new ReviewFindingResolutionError(error.message);
          }
          throw new ReviewFindingResolutionError(
            "Не удалось разобрать implementation-review.md выбранного change",
          );
        }
      },
    },
    agent: {
      toolName: "complete_implementation_review_finding",
      toolDescription:
        "Проверить устранение и Git-публикацию implementation finding, затем опубликовать её итог в корневом PR",
      title: (findingId) => `Устранение implementation finding: ${findingId}`,
      logLabel: "implementation review finding",
      completionLabel: "Implementation finding",
      prompt: implementationFindingResolutionPrompt,
    },
    publication: {
      kind: "implementation-review",
    },
  });
}

export function implementationFindingResolutionPrompt(
  input: ReviewFindingPromptInput,
): string {
  return buildFindingResolutionPrompt(
    {
      reviewName: "an OpenSpec implementation review",
      skill: "openspec-review-implementation",
      toolName: "complete_implementation_review_finding",
    },
    input,
  );
}
