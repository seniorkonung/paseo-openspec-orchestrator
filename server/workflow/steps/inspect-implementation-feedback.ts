import type { ImplementationPullRequestService } from "../../implementation-pull-request.ts";
import type { PrFeedbackReviewService } from "../../pr-feedback-review.ts";
import { implementationRunSchema } from "../../implementation-run-model.ts";
import type { WorkflowStepContext, WorkflowStepDefinition, WorkflowStepResult } from "../types.ts";

export interface InspectImplementationFeedbackDependencies {
  readonly workspaceDirectory: string;
  readonly pullRequest: ImplementationPullRequestService;
  readonly feedbackReview: Pick<PrFeedbackReviewService, "plan">;
}

async function runStep(
  dependencies: InspectImplementationFeedbackDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const run = context.state.implementationRun;
  if (!run || run.batch.kind !== "empty") {
    return { kind: "halt", summary: "Implementation-run не готов к PR gate", message: "Сначала завершите задачи, review и findings" };
  }
  try {
    const inspection = await dependencies.pullRequest.inspectFeedback(
      dependencies.workspaceDirectory,
      run,
      context.signal,
    );
    if (inspection.kind === "merged") {
      await context.checkpointState({ ...context.state, pendingImplementationMergeSession: inspection.session });
      return { kind: "continue", next: "await-implementation-merge", summary: "Implementation PR уже слит" };
    }
    if (inspection.kind === "feedback") {
      const session = await dependencies.feedbackReview.plan(
        dependencies.workspaceDirectory,
        run,
        inspection.items,
        context.signal,
      );
      await context.checkpointState({ ...context.state, pendingPrFeedbackReviewSession: session });
      return { kind: "continue", next: "review-pr-feedback", summary: `Найдено новых элементов PR feedback: ${inspection.items.length}` };
    }
    const ready = await dependencies.pullRequest.markReady(
      dependencies.workspaceDirectory,
      run,
      context.signal,
    );
    if (ready.kind === "feedback") {
      const session = await dependencies.feedbackReview.plan(
        dependencies.workspaceDirectory,
        run,
        ready.items,
        context.signal,
      );
      await context.checkpointState({ ...context.state, pendingPrFeedbackReviewSession: session });
      return { kind: "continue", next: "review-pr-feedback", summary: "Во время Ready-перехода появился новый PR feedback" };
    }
    if (ready.kind === "merged") {
      await context.checkpointState({ ...context.state, pendingImplementationMergeSession: ready.session });
      return { kind: "continue", next: "await-implementation-merge", summary: "Implementation PR слит во время проверки" };
    }
    return {
      kind: "continue",
      next: "await-implementation-merge",
      state: {
        implementationRun: implementationRunSchema.parse({
          ...run,
          publication: run.publication.kind === "unpublished"
            ? run.publication
            : { ...run.publication, kind: "ready-pr" },
        }),
      },
      summary: "Implementation pull request готов к merge",
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary = error instanceof Error ? error.message : "Не удалось проверить implementation PR";
    return { kind: "halt", summary, message: `${summary}; исправьте состояние и нажмите «Повторить»` };
  }
}

export function createInspectImplementationFeedbackStep(
  dependencies: InspectImplementationFeedbackDependencies,
): WorkflowStepDefinition {
  return { id: "inspect-implementation-feedback", label: "Проверяю feedback implementation PR", run: (context) => runStep(dependencies, context) };
}
