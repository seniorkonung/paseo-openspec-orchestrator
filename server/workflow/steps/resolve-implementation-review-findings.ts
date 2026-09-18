import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
  type AgentProfileReader,
} from "../../agent-profiles.ts";
import {
  ImplementationFindingResolutionError,
  type ImplementationFindingResolutionService,
} from "../../implementation-finding-resolution.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export interface ResolveImplementationReviewFindingsDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly findingResolution: Pick<
    ImplementationFindingResolutionService,
    "plan" | "run"
  >;
}

async function resolveImplementationReviewFindingsStep(
  dependencies: ResolveImplementationReviewFindingsDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { branch, change } = context.state;
  if (!branch || !change) {
    return {
      kind: "halt",
      summary: "Недостаточно данных для устранения implementation findings",
      message: "Git-ветка или OpenSpec change не сохранены; запустите workflow заново",
    };
  }
  if (
    context.state.pendingArtifactSession ||
    context.state.pendingReviewSession ||
    context.state.pendingFindingResolutionSession
  ) {
    return {
      kind: "halt",
      summary: "Другая незавершённая сессия блокирует implementation findings",
      message: "Завершите предыдущую агентскую сессию и запустите workflow заново",
    };
  }

  let session = context.state.pendingImplementationFindingResolutionSession;
  if (!session) {
    try {
      const plan = await dependencies.findingResolution.plan(
        dependencies.workspaceDirectory,
        change.id,
        branch,
        context.signal,
      );
      if (plan.kind === "no-findings") {
        return {
          kind: "continue",
          next: "execute-change-tasks",
          state: { pendingImplementationFindingResolutionSession: null },
          summary: `В implementation review нет нерешённых findings: ${plan.reviewPath}`,
        };
      }
      session = plan.session;
      await context.checkpointState({
        ...context.state,
        pendingImplementationFindingResolutionSession: session,
      });
    } catch (error) {
      return findingFailure(
        context,
        error,
        "Не удалось определить следующую implementation finding",
      );
    }
  }

  let profiles;
  try {
    profiles = await dependencies.readAgentProfiles();
  } catch (error) {
    if (context.signal.aborted) throw error;
    console.error(
      "[OpenSpec] Не удалось перечитать профили перед устранением implementation finding",
      { code: errorCode(error) },
    );
    return {
      kind: "halt",
      summary: "Не удалось перечитать профили агентов",
      message:
        "Не удалось перечитать профиль High Sandbox перед устранением implementation finding; проверьте Paseo и нажмите «Повторить»",
    };
  }

  const resolution = resolveRequiredAgentProfile(profiles, "High Sandbox");
  if (resolution.kind === "invalid") {
    const summary = describeRequiredAgentProfileProblem("High Sandbox", resolution);
    return {
      kind: "halt",
      summary,
      message: `${summary}; исправьте Agent profiles в Paseo и нажмите «Повторить»`,
    };
  }

  try {
    const completed = await dependencies.findingResolution.run({
      workspaceDirectory: dependencies.workspaceDirectory,
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
            label: `Implementation finding ${session.findingId}`,
          },
        ]);
      },
      onFindingResolved: async () => {
        await context.checkpointState({
          ...context.state,
          pendingImplementationFindingResolutionSession: null,
        });
      },
    });

    if (completed.remainingFindingIds.length === 0) {
      return {
        kind: "continue",
        next: "execute-change-tasks",
        state: { pendingImplementationFindingResolutionSession: null },
        summary: `Обработана последняя implementation finding ${completed.findingId}; обновлён PR #${completed.pullRequest.number}`,
      };
    }
    return {
      kind: "continue",
      next: "resolve-implementation-review-findings",
      state: { pendingImplementationFindingResolutionSession: null },
      summary:
        `Обработана implementation finding ${completed.findingId} в PR #${completed.pullRequest.number}; осталось ${completed.remainingFindingIds.length}`,
    };
  } catch (error) {
    return findingFailure(
      context,
      error,
      "Не удалось завершить устранение implementation finding",
    );
  }
}

function findingFailure(
  context: WorkflowStepContext,
  error: unknown,
  fallback: string,
): WorkflowStepResult {
  if (context.signal.aborted) throw error;
  console.error("[OpenSpec] Ошибка устранения implementation review finding", {
    code: errorCode(error),
  });
  const summary = error instanceof ImplementationFindingResolutionError
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

export function createResolveImplementationReviewFindingsStep(
  dependencies: ResolveImplementationReviewFindingsDependencies,
): WorkflowStepDefinition {
  return {
    id: "resolve-implementation-review-findings",
    label: "Устраняю findings implementation review",
    run: (context) => resolveImplementationReviewFindingsStep(dependencies, context),
  };
}
