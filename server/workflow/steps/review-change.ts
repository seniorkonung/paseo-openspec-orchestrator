import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
} from "../../agent-profiles.ts";
import { ChangeReviewError } from "../../change-review.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export async function reviewChangeStep(
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { branch, change } = context.state;
  if (!branch || !change) {
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
      const plan = await context.services.changeReview.plan(
        context.workspaceDirectory,
        change.id,
        branch,
        context.signal,
      );
      if (plan.kind === "already-reviewed") {
        return {
          kind: "complete",
          state: { pendingReviewSession: null },
          summary: `Review OpenSpec change уже опубликован: ${plan.reviewPath}`,
        };
      }
      session = plan.session;
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
    profiles = await context.services.readAgentProfiles();
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
    const review = await context.services.changeReview.run({
      workspaceDirectory: context.workspaceDirectory,
      changeId: change.id,
      branch,
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
      onReviewCompleted: async () => {
        await context.checkpointState({
          ...context.state,
          pendingReviewSession: null,
        });
      },
    });
    return {
      kind: "complete",
      state: { pendingReviewSession: null },
      summary: `Review OpenSpec change опубликован: ${review.reviewPath}`,
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
  const summary = error instanceof ChangeReviewError ? error.message : fallback;
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

export const reviewChange: WorkflowStepDefinition = {
  id: "review-change",
  label: "Провожу review OpenSpec change",
  run: reviewChangeStep,
};
