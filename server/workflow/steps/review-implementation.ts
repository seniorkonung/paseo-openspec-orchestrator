import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
  type AgentProfileReader,
} from "../../agent-profiles.ts";
import {
  ImplementationReviewError,
  type ImplementationReviewService,
} from "../../implementation-review.ts";
import { implementationRunSchema } from "../../implementation-run-model.ts";
import type { WorkflowStepContext, WorkflowStepDefinition, WorkflowStepResult } from "../types.ts";

export interface ReviewImplementationDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly implementationReview: ImplementationReviewService;
}

async function runStep(
  dependencies: ReviewImplementationDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const run = context.state.implementationRun;
  if (!run || run.batch.kind !== "collecting") {
    return { kind: "halt", summary: "Нет непустого implementation-пакета", message: "Implementation review требует выполненные task-коммиты" };
  }
  let session = context.state.pendingImplementationReviewSession;
  try {
    if (!session) {
      session = await dependencies.implementationReview.plan(
        dependencies.workspaceDirectory,
        run,
        context.signal,
      );
      await context.checkpointState({ ...context.state, pendingImplementationReviewSession: session });
    }
    const profiles = await dependencies.readAgentProfiles();
    const resolution = resolveRequiredAgentProfile(profiles, "High Sandbox");
    if (resolution.kind === "invalid") {
      const summary = describeRequiredAgentProfileProblem("High Sandbox", resolution);
      return { kind: "halt", summary, message: `${summary}; исправьте Agent profiles и нажмите «Повторить»` };
    }
    const completed = await dependencies.implementationReview.run({
      workspaceDirectory: dependencies.workspaceDirectory,
      profile: resolution.profile,
      run,
      session,
      signal: context.signal,
      onAgentCreated: (agentId) => context.updateActionLinks([{ kind: "agent", agentId, label: "Implementation review" }]),
      onReviewCompleted: async (review) => {
        const nextRun = reviewedRun(run, review);
        await context.checkpointState({
          ...context.state,
          implementationRun: nextRun,
          pendingImplementationReviewSession: null,
        });
      },
    });
    return {
      kind: "continue",
      next: "resolve-review-findings",
      state: {
        implementationRun: reviewedRun(run, completed),
        pendingImplementationReviewSession: null,
      },
      summary: `Пакет ${completed.baseCommit}..${completed.reviewedHead} проверен в Draft PR #${completed.pullRequest.number}`,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary = error instanceof ImplementationReviewError
      ? error.message
      : "Не удалось завершить implementation review";
    return { kind: "halt", summary, message: `${summary}; исправьте состояние и нажмите «Повторить»` };
  }
}

function reviewedRun(
  run: NonNullable<WorkflowStepContext["state"]["implementationRun"]>,
  review: { readonly reviewedHead: string; readonly reviewCommit: string; readonly pullRequest: { readonly number: number; readonly url: string; readonly title: string } },
) {
  if (run.batch.kind !== "collecting") throw new ImplementationReviewError("Task-пакет уже изменился");
  return implementationRunSchema.parse({
    ...run,
    publication: { kind: "draft-pr", ...review.pullRequest },
    batch: {
      kind: "reviewed",
      baseCommit: run.batch.baseCommit,
      headCommit: run.batch.headCommit,
      reviewCommit: review.reviewCommit,
      tasks: run.batch.tasks,
    },
    lastDeliveryHead: review.reviewedHead,
  });
}

export function createReviewImplementationStep(
  dependencies: ReviewImplementationDependencies,
): WorkflowStepDefinition {
  return { id: "review-implementation", label: "Проверяю пакет implementation-коммитов", run: (context) => runStep(dependencies, context) };
}
