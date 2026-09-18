import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
  type AgentProfileReader,
} from "../../agent-profiles.ts";
import { ChangeReviewError, type ChangeReviewService } from "../../change-review.ts";
import { ChangeReviewPublicationError } from "../../change-review-publication.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export interface ReviewChangeDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly changeReview: Pick<ChangeReviewService, "plan" | "run">;
}

async function reviewChangeStep(
  dependencies: ReviewChangeDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { changeBranch, activeBranch, change } = context.state;
  if (!changeBranch || !activeBranch || !change) {
    return {
      kind: "halt",
      summary: "Недостаточно данных для review change",
      message: "Git-ветка или OpenSpec change не сохранены; запустите workflow заново",
    };
  }
  if (context.state.pendingArtifactSession) {
    return {
      kind: "halt",
      summary: "Незавершённая artifact-сессия блокирует review",
      message: "Завершите создание planning-артефакта и запустите workflow заново",
    };
  }

  let session = context.state.pendingReviewSession;
  if (!session) {
    try {
      session = await dependencies.changeReview.plan(
        dependencies.workspaceDirectory,
        change.id,
        changeBranch,
        activeBranch,
        context.signal,
      );
      await context.checkpointState({
        ...context.state,
        pendingReviewSession: session,
      });
    } catch (error) {
      return reviewFailure(context, error, "Не удалось подготовить review change");
    }
  }

  let profiles;
  try {
    profiles = await dependencies.readAgentProfiles();
  } catch (error) {
    if (context.signal.aborted) throw error;
    console.error("[OpenSpec] Не удалось перечитать профили перед review", {
      code: errorCode(error),
    });
    return {
      kind: "halt",
      summary: "Не удалось перечитать профили агентов",
      message:
        "Не удалось перечитать профиль Ultra Sandbox перед review; проверьте Paseo и нажмите «Повторить»",
    };
  }

  const resolution = resolveRequiredAgentProfile(profiles, "Ultra Sandbox");
  if (resolution.kind === "invalid") {
    const summary = describeRequiredAgentProfileProblem("Ultra Sandbox", resolution);
    return {
      kind: "halt",
      summary,
      message: `${summary}; исправьте Agent profiles в Paseo и нажмите «Повторить»`,
    };
  }

  try {
    const review = await dependencies.changeReview.run({
      workspaceDirectory: dependencies.workspaceDirectory,
      profile: resolution.profile,
      session,
      signal: context.signal,
      onAgentCreated: (agentId) => {
        context.updateActionLinks([
          {
            kind: "agent",
            agentId,
            label: `Review change ${change.id}`,
          },
        ]);
      },
    });
    return {
      kind: "continue",
      next: "resolve-review-findings",
      state: { activeBranch: review.branch, pendingReviewSession: null },
      summary: `Review OpenSpec change опубликован в PR #${review.pullRequest.number}: ${review.pullRequest.url}`,
    };
  } catch (error) {
    return reviewFailure(context, error, "Не удалось завершить review change");
  }
}

function reviewFailure(
  context: WorkflowStepContext,
  error: unknown,
  fallback: string,
): WorkflowStepResult {
  if (context.signal.aborted) throw error;
  console.error("[OpenSpec] Ошибка review OpenSpec change", {
    code: errorCode(error),
  });
  const summary =
    error instanceof ChangeReviewError ||
    error instanceof ChangeReviewPublicationError
      ? error.message
      : fallback;
  return {
    kind: "halt",
    summary,
    message: `${summary}; исправьте состояние и нажмите «Повторить»`,
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}

export function createReviewChangeStep(
  dependencies: ReviewChangeDependencies,
): WorkflowStepDefinition {
  return {
    id: "review-change",
    label: "Провожу review OpenSpec change",
    run: (context) => reviewChangeStep(dependencies, context),
  };
}
