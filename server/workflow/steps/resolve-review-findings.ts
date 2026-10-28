import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
  type AgentProfileReader,
} from "../../agent-profiles.ts";
import {
  ChangeFindingResolutionError,
  type ChangeFindingResolutionService,
  type PendingFindingResolutionSession,
} from "../../change-finding-resolution.ts";
import {
  ImplementationRunVerificationError,
  type ImplementationRunVerifier,
} from "../../implementation-run-verification.ts";
import {
  PhaseWorkError,
  inspectWithinTaskScope,
  type PhaseTaskScope,
  type PhaseWorkService,
} from "../../phase-work.ts";
import { summarizeFindingDecisions } from "../../review-finding-decision-model.ts";
import { RootBranchDeliveryError } from "../../root-branch-delivery.ts";
import { ORCHESTRATOR_LIMITS } from "../../../shared/orchestrator.ts";
import type { FindingWork } from "../../review-finding-resolution-model.ts";
import { ensureInitialPlannedPhases, workflowTaskScope } from "../task-scope.ts";
import type {
  WorkflowState,
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export interface ResolveReviewFindingsDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly findingResolution: Pick<ChangeFindingResolutionService, "plan" | "run" | "decide">;
  readonly implementationRunVerification: Pick<ImplementationRunVerifier, "assertCurrent">;
  readonly phaseWork: Pick<PhaseWorkService, "inspect">;
}

async function resolveReviewFindingsStep(
  dependencies: ResolveReviewFindingsDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { activeBranch, change } = context.state;
  if (!activeBranch || !change) {
    return {
      kind: "halt",
      summary: "Недостаточно данных для устранения findings",
      message: "Git-ветка или OpenSpec change не сохранены; запустите workflow заново",
    };
  }
  if (
    context.state.pendingArtifactSession ||
    context.state.pendingReviewSession ||
    context.state.pendingImplementationFindingDecisionSession ||
    context.state.pendingImplementationFindingResolutionSession
  ) {
    return {
      kind: "halt",
      summary: "Другая незавершённая сессия блокирует устранение findings",
      message: "Завершите предыдущую artifact- или review-сессию и запустите workflow заново",
    };
  }

  let state: WorkflowState;
  let taskScope: PhaseTaskScope;
  try {
    // Обычно фазы начального планирования уже сохранил review-change. Если
    // checkpoint создан до их появления, baseline снимается здесь и уже
    // включает правки завершённого review.
    state = await ensureInitialPlannedPhases(
      dependencies.phaseWork,
      dependencies.workspaceDirectory,
      change.id,
      context,
    );
    taskScope = workflowTaskScope(state);
  } catch (error) {
    return findingFailure(context, error, "Не удалось определить фазы с задачами для findings");
  }

  // Сначала исполняются уже принятые решения; сессия решений собирает
  // решения сразу по всем открытым findings, у которых их нет.
  let work: FindingWork<PendingFindingResolutionSession> | null =
    state.pendingFindingDecisionSession
      ? { kind: "decisions", session: state.pendingFindingDecisionSession }
      : state.pendingFindingResolutionSession
        ? { kind: "resolution", session: state.pendingFindingResolutionSession }
        : null;
  if (!work) {
    try {
      if (state.implementationRun) {
        await dependencies.implementationRunVerification.assertCurrent(
          dependencies.workspaceDirectory,
          state.implementationRun,
          context.signal,
        );
      }
      const plan = await dependencies.findingResolution.plan(
        dependencies.workspaceDirectory,
        change.id,
        activeBranch,
        context.signal,
      );
      switch (plan.kind) {
        case "no-findings":
          return await continueAfterReviewFindings(
            dependencies,
            context,
            change.id,
            taskScope,
            `В review нет нерешённых findings: ${plan.reviewPath}`,
          );
        case "decisions-required":
          work = { kind: "decisions", session: plan.session };
          await context.checkpointState({ ...state, pendingFindingDecisionSession: plan.session });
          break;
        case "finding-required":
          work = { kind: "resolution", session: plan.session };
          await context.checkpointState({ ...state, pendingFindingResolutionSession: plan.session });
          break;
      }
    } catch (error) {
      return findingFailure(context, error, "Не удалось определить следующую finding");
    }
  }

  let profiles;
  try {
    profiles = await dependencies.readAgentProfiles();
  } catch (error) {
    if (context.signal.aborted) throw error;
    console.error("[OpenSpec] Не удалось перечитать профили перед устранением finding", {
      code: errorCode(error),
    });
    return {
      kind: "halt",
      summary: "Не удалось перечитать профили агентов",
      message:
        "Не удалось перечитать профиль High перед устранением finding; проверьте Paseo и нажмите «Повторить»",
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

  const assertRunCurrent = async (): Promise<void> => {
    if (state.implementationRun) {
      await dependencies.implementationRunVerification.assertCurrent(
        dependencies.workspaceDirectory,
        state.implementationRun,
        context.signal,
      );
    }
  };

  if (work.kind === "decisions") {
    try {
      const recorded = await dependencies.findingResolution.decide({
        workspaceDirectory: dependencies.workspaceDirectory,
        changeId: change.id,
        branch: activeBranch,
        profile: resolution.profile,
        session: work.session,
        taskScope,
        signal: context.signal,
        onAgentCreated: (agentId) => {
          context.updateActionLinks([
            { kind: "agent", agentId, label: "Решения по findings" },
          ]);
        },
        onDecisionsRecorded: async () => {
          await assertRunCurrent();
          await context.checkpointState({ ...state, pendingFindingDecisionSession: null });
        },
      });
      return {
        kind: "continue",
        next: "resolve-review-findings",
        state: { pendingFindingDecisionSession: null },
        summary: boundedSummary(
          `Записаны решения по findings review (${summarizeFindingDecisions(recorded.decisions)})`,
        ),
      };
    } catch (error) {
      return findingFailure(context, error, "Не удалось записать решения по findings");
    }
  }
  const resolutionSession = work.session;

  try {
    const completed = await dependencies.findingResolution.run({
      workspaceDirectory: dependencies.workspaceDirectory,
      changeId: change.id,
      branch: activeBranch,
      profile: resolution.profile,
      session: resolutionSession,
      taskScope,
      signal: context.signal,
      onAgentCreated: (agentId) => {
        context.updateActionLinks([
          {
            kind: "agent",
            agentId,
            label: `Finding ${resolutionSession.findingId}`,
          },
        ]);
      },
      onFindingResolved: async () => {
        await assertRunCurrent();
        await context.checkpointState({
          ...state,
          pendingFindingResolutionSession: null,
        });
      },
    });

    if (completed.outcome === "blocked") {
      return {
        kind: "continue",
        next: "resolve-review-findings",
        state: { pendingFindingResolutionSession: null },
        summary: boundedSummary(
          `Finding ${completed.findingId} возвращена к решению пользователя: ${completed.reason}`,
        ),
      };
    }
    if (completed.remainingFindingIds.length === 0) {
      return await continueAfterReviewFindings(
        dependencies,
        context,
        change.id,
        taskScope,
        `Обработана последняя finding review ${completed.findingId}; обновлён PR #${completed.pullRequest.number}`,
      );
    }
    return {
      kind: "continue",
      next: "resolve-review-findings",
      state: { pendingFindingResolutionSession: null },
      summary: `Обработана finding ${completed.findingId} в PR #${completed.pullRequest.number}; осталось ${completed.remainingFindingIds.length}`,
    };
  } catch (error) {
    return findingFailure(context, error, "Не удалось завершить устранение finding");
  }
}

/**
 * Внутри run следующий шаг устраняет implementation findings. Начальное
 * планирование переходит к первой проверке фаз только после финальной проверки,
 * что review и findings не наполнили фазы, которые планирует оркестратор.
 */
async function continueAfterReviewFindings(
  dependencies: ResolveReviewFindingsDependencies,
  context: WorkflowStepContext,
  changeId: string,
  taskScope: PhaseTaskScope,
  summary: string,
): Promise<WorkflowStepResult> {
  if (taskScope.kind !== "initial-planning") {
    return {
      kind: "continue",
      next: "resolve-implementation-review-findings",
      state: { pendingFindingDecisionSession: null, pendingFindingResolutionSession: null },
      summary,
    };
  }
  await inspectWithinTaskScope(
    dependencies.phaseWork,
    dependencies.workspaceDirectory,
    changeId,
    taskScope,
    context.signal,
  );
  return {
    kind: "continue",
    next: "inspect-phase-work",
    state: {
      pendingFindingDecisionSession: null,
      pendingFindingResolutionSession: null,
      initialPlannedPhases: null,
    },
    summary,
  };
}

function findingFailure(
  context: WorkflowStepContext,
  error: unknown,
  fallback: string,
): WorkflowStepResult {
  if (context.signal.aborted) throw error;
  console.error("[OpenSpec] Ошибка устранения review finding", {
    code: errorCode(error),
  });
  const summary =
    error instanceof ChangeFindingResolutionError ||
      error instanceof ImplementationRunVerificationError ||
      error instanceof RootBranchDeliveryError ||
      error instanceof PhaseWorkError
      ? error.message
      : fallback;
  return {
    kind: "halt",
    summary,
    message: `${summary}; исправьте состояние и нажмите «Повторить»`,
  };
}

/** Текст действия в ledger ограничен по длине. */
function boundedSummary(text: string): string {
  const maximum = ORCHESTRATOR_LIMITS.actionText;
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}

export function createResolveReviewFindingsStep(
  dependencies: ResolveReviewFindingsDependencies,
): WorkflowStepDefinition {
  return {
    id: "resolve-review-findings",
    label: "Устраняю findings OpenSpec review",
    run: (context) => resolveReviewFindingsStep(dependencies, context),
  };
}
