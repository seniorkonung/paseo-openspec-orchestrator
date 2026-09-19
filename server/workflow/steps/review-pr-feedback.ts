import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
  type AgentProfileReader,
} from "../../agent-profiles.ts";
import { implementationRunSchema } from "../../implementation-run-model.ts";
import { PrFeedbackReviewError, type PrFeedbackReviewService } from "../../pr-feedback-review.ts";
import type { WorkflowStepContext, WorkflowStepDefinition, WorkflowStepResult } from "../types.ts";

export interface ReviewPrFeedbackDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly feedbackReview: Pick<PrFeedbackReviewService, "run">;
}

async function runStep(
  dependencies: ReviewPrFeedbackDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const run = context.state.implementationRun;
  const session = context.state.pendingPrFeedbackReviewSession;
  if (!run || !session) {
    return { kind: "halt", summary: "Feedback-сессия не сохранена", message: "Повторно запустите проверку implementation PR" };
  }
  try {
    const profiles = await dependencies.readAgentProfiles();
    const resolution = resolveRequiredAgentProfile(profiles, "High");
    if (resolution.kind === "invalid") {
      const summary = describeRequiredAgentProfileProblem("High", resolution);
      return { kind: "halt", summary, message: `${summary}; исправьте Agent profiles и нажмите «Повторить»` };
    }
    const completed = await dependencies.feedbackReview.run({
      workspaceDirectory: dependencies.workspaceDirectory,
      profile: resolution.profile,
      run,
      session,
      signal: context.signal,
      onAgentCreated: (agentId) => context.updateActionLinks([{ kind: "agent", agentId, label: "PR feedback review" }]),
      onFeedbackReviewed: async (result) => {
        await context.checkpointState({
          ...context.state,
          implementationRun: applyResult(run, result),
          pendingPrFeedbackReviewSession: null,
        });
      },
    });
    return {
      kind: "continue",
      next: "resolve-review-findings",
      state: {
        implementationRun: applyResult(run, completed),
        pendingPrFeedbackReviewSession: null,
      },
      summary: `Обработано элементов PR feedback: ${completed.processedFingerprints.length}`,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary = error instanceof PrFeedbackReviewError ? error.message : "Не удалось завершить PR feedback review";
    return { kind: "halt", summary, message: `${summary}; исправьте состояние и нажмите «Повторить»` };
  }
}

function applyResult(
  run: NonNullable<WorkflowStepContext["state"]["implementationRun"]>,
  result: { readonly head: string; readonly processedFingerprints: readonly string[] },
) {
  const fingerprints = [...run.processedFeedbackFingerprints, ...result.processedFingerprints];
  return implementationRunSchema.parse({
    ...run,
    publication: run.publication.kind === "unpublished"
      ? run.publication
      : { ...run.publication, kind: "draft-pr" },
    batch: { kind: "empty", baseCommit: result.head },
    processedFeedbackFingerprints: [...new Set(fingerprints)],
  });
}

export function createReviewPrFeedbackStep(
  dependencies: ReviewPrFeedbackDependencies,
): WorkflowStepDefinition {
  return { id: "review-pr-feedback", label: "Проверяю новый PR feedback", run: (context) => runStep(dependencies, context) };
}
