import {
  ImplementationPullRequestError,
  type ImplementationPullRequestService,
} from "../../implementation-pull-request.ts";
import type { PrFeedbackReviewService } from "../../pr-feedback-review.ts";
import type { OpenSpecChangeVerifier } from "../../openspec-change.ts";
import type { WorkflowStepContext, WorkflowStepDefinition, WorkflowStepResult } from "../types.ts";

export interface AwaitImplementationMergeDependencies {
  readonly workspaceDirectory: string;
  readonly pullRequest: ImplementationPullRequestService;
  readonly feedbackReview: Pick<PrFeedbackReviewService, "plan">;
  readonly verifyChange: OpenSpecChangeVerifier;
}

async function runStep(
  dependencies: AwaitImplementationMergeDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const run = context.state.implementationRun;
  if (!run) return { kind: "halt", summary: "Implementation-run не сохранён", message: "Запустите workflow заново" };
  try {
    let mergeSession = context.state.pendingImplementationMergeSession;
    if (!mergeSession) {
      const inspection = await dependencies.pullRequest.inspectReadyGate(
        dependencies.workspaceDirectory,
        run,
        context.signal,
      );
      if (inspection.kind === "open") {
        return {
          kind: "halt",
          summary: `Implementation PR #${inspection.number} ожидает merge`,
          message: `Выполните merge ${inspection.url} или оставьте комментарии, затем нажмите «Повторить»`,
        };
      }
      if (inspection.kind === "feedback") {
        const session = await dependencies.feedbackReview.plan(
          dependencies.workspaceDirectory,
          run,
          inspection.items,
          context.signal,
        );
        await context.checkpointState({
          ...context.state,
          implementationRun: run.publication.kind === "unpublished" ? run : {
            ...run,
            publication: { ...run.publication, kind: "draft-pr" },
          },
          pendingPrFeedbackReviewSession: session,
        });
        return { kind: "continue", next: "review-pr-feedback", summary: `Получен новый PR feedback: ${inspection.items.length}` };
      }
      mergeSession = inspection.session;
      await context.checkpointState({ ...context.state, pendingImplementationMergeSession: mergeSession });
    }
    await dependencies.pullRequest.completeMerge(
      dependencies.workspaceDirectory,
      run,
      mergeSession,
      context.signal,
    );
    await dependencies.verifyChange(dependencies.workspaceDirectory, run.changeId, context.signal);
    return {
      kind: "continue",
      next: "inspect-phase-work",
      state: {
        activeBranch: run.changeBranch,
        implementationRun: null,
        phaseTarget: null,
        pendingImplementationMergeSession: null,
      },
      summary: `Implementation PR слит; ${run.changeBranch} обновлена fast-forward`,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary = error instanceof ImplementationPullRequestError ? error.message : "Не удалось подтвердить merge implementation PR";
    return { kind: "halt", summary, message: `${summary}; исправьте состояние и нажмите «Повторить»` };
  }
}

export function createAwaitImplementationMergeStep(
  dependencies: AwaitImplementationMergeDependencies,
): WorkflowStepDefinition {
  return { id: "await-implementation-merge", label: "Ожидаю merge implementation pull request", run: (context) => runStep(dependencies, context) };
}
