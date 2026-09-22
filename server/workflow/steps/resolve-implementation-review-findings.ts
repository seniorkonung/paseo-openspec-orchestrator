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
import {
  clearImplementationBatch,
  type ImplementationRun,
} from "../../implementation-run-model.ts";
import {
  ImplementationRunVerificationError,
  type ImplementationRunVerifier,
} from "../../implementation-run-verification.ts";
import {
  PhaseWorkError,
  type PhaseWorkService,
} from "../../phase-work.ts";

export interface ResolveImplementationReviewFindingsDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly findingResolution: Pick<
    ImplementationFindingResolutionService,
    "plan" | "run"
  >;
  readonly implementationRunVerification: Pick<ImplementationRunVerifier, "assertCurrent">;
  readonly phaseWork: Pick<PhaseWorkService, "inspect">;
}

async function resolveImplementationReviewFindingsStep(
  dependencies: ResolveImplementationReviewFindingsDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { activeBranch, change } = context.state;
  const implementationRun = context.state.implementationRun;
  const planningRun = context.state.planningRun;
  if (!activeBranch || !change || (!implementationRun && !planningRun)) {
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
      if (implementationRun) {
        await dependencies.implementationRunVerification.assertCurrent(
          dependencies.workspaceDirectory,
          implementationRun,
          context.signal,
        );
      }
      const plan = await dependencies.findingResolution.plan(
        dependencies.workspaceDirectory,
        change.id,
        activeBranch,
        context.signal,
      );
      if (plan.kind === "no-findings") {
        if (implementationRun) {
          return continueImplementationAfterFindings(
            dependencies,
            context,
            implementationRun,
            plan.headCommit,
            `В implementation review нет нерешённых findings: ${plan.reviewPath}`,
          );
        }
        return {
          kind: "continue",
          next: "validate-phase-planning",
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
        "Не удалось перечитать профиль High перед устранением implementation finding; проверьте Paseo и нажмите «Повторить»",
    };
  }

  const resolution = resolveRequiredAgentProfile(profiles, "High");
  if (resolution.kind === "invalid") {
    const summary = describeRequiredAgentProfileProblem("High", resolution);
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
      branch: activeBranch,
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
        if (implementationRun) {
          await dependencies.implementationRunVerification.assertCurrent(
            dependencies.workspaceDirectory,
            implementationRun,
            context.signal,
          );
        }
        await context.checkpointState({
          ...context.state,
          pendingImplementationFindingResolutionSession: null,
        });
      },
    });

    if (completed.remainingFindingIds.length === 0) {
      if (implementationRun) {
        return continueImplementationAfterFindings(
          dependencies,
          context,
          implementationRun,
          completed.commit,
          `Обработана последняя implementation finding ${completed.findingId}; обновлён PR #${completed.pullRequest.number}`,
        );
      }
      return {
        kind: "continue",
        next: "validate-phase-planning",
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
  const summary =
    error instanceof ImplementationFindingResolutionError ||
      error instanceof ImplementationRunVerificationError ||
      error instanceof PhaseWorkError
      ? error.message
      : fallback;
  return {
    kind: "halt",
    summary,
    message: `${summary}; исправьте состояние и нажмите «Повторить»`,
  };
}

async function continueImplementationAfterFindings(
  dependencies: ResolveImplementationReviewFindingsDependencies,
  context: WorkflowStepContext,
  implementationRun: ImplementationRun,
  headCommit: string,
  summary: string,
): Promise<WorkflowStepResult> {
  const previous = context.state.phaseProgress;
  if (!previous) {
    throw new PhaseWorkError("Не сохранён baseline задач implementation-run");
  }
  // Finding может добавить remediation-задачи. Сохраняем их, пока они ещё
  // незавершены, чтобы post-merge защита отличала их от внешней подмены задач.
  const decision = await dependencies.phaseWork.inspect(
    dependencies.workspaceDirectory,
    implementationRun.changeId,
    previous,
    context.signal,
  );
  return {
    kind: "continue",
    next: "execute-change-tasks",
    state: {
      phaseProgress: decision.progress,
      implementationRun: clearImplementationBatch(implementationRun, headCommit),
      pendingImplementationFindingResolutionSession: null,
    },
    summary,
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
