import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
  type AgentProfileReader,
} from "../../agent-profiles.ts";
import {
  ImplementationFindingResolutionError,
  type ImplementationFindingResolutionService,
  type PendingImplementationFindingResolutionSession,
} from "../../implementation-finding-resolution.ts";
import { summarizeFindingDecisions } from "../../review-finding-decision-model.ts";
import { RootBranchDeliveryError } from "../../root-branch-delivery.ts";
import { ORCHESTRATOR_LIMITS } from "../../../shared/orchestrator.ts";
import type { FindingWork } from "../../review-finding-resolution-model.ts";
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
  inspectWithinTaskScope,
  type PhaseTaskScope,
  type PhaseWorkService,
} from "../../phase-work.ts";
import { workflowTaskScope } from "../task-scope.ts";

export interface ResolveImplementationReviewFindingsDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly findingResolution: Pick<
    ImplementationFindingResolutionService,
    "plan" | "run" | "decide"
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
    context.state.pendingFindingDecisionSession ||
    context.state.pendingFindingResolutionSession
  ) {
    return {
      kind: "halt",
      summary: "Другая незавершённая сессия блокирует implementation findings",
      message: "Завершите предыдущую агентскую сессию и запустите workflow заново",
    };
  }

  let taskScope: PhaseTaskScope;
  try {
    taskScope = workflowTaskScope(context.state);
  } catch (error) {
    return findingFailure(context, error, "Не удалось определить фазу для новых задач");
  }

  const assertRunCurrent = async (): Promise<void> => {
    if (implementationRun) {
      await dependencies.implementationRunVerification.assertCurrent(
        dependencies.workspaceDirectory,
        implementationRun,
        context.signal,
      );
    }
  };

  // Сначала исполняются уже принятые решения; сессия решений собирает
  // решения сразу по всем открытым findings, у которых их нет.
  let work: FindingWork<PendingImplementationFindingResolutionSession> | null =
    context.state.pendingImplementationFindingDecisionSession
      ? { kind: "decisions", session: context.state.pendingImplementationFindingDecisionSession }
      : context.state.pendingImplementationFindingResolutionSession
        ? { kind: "resolution", session: context.state.pendingImplementationFindingResolutionSession }
        : null;
  if (!work) {
    try {
      await assertRunCurrent();
      const plan = await dependencies.findingResolution.plan(
        dependencies.workspaceDirectory,
        change.id,
        activeBranch,
        context.signal,
      );
      switch (plan.kind) {
        case "no-findings":
          return await finishFindings(
            dependencies,
            context,
            plan.headCommit,
            `В implementation review нет нерешённых findings: ${plan.reviewPath}`,
          );
        case "decisions-required":
          work = { kind: "decisions", session: plan.session };
          await context.checkpointState({
            ...context.state,
            pendingImplementationFindingDecisionSession: plan.session,
          });
          break;
        case "finding-required":
          work = { kind: "resolution", session: plan.session };
          await context.checkpointState({
            ...context.state,
            pendingImplementationFindingResolutionSession: plan.session,
          });
          break;
      }
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
            { kind: "agent", agentId, label: "Решения по implementation findings" },
          ]);
        },
        onDecisionsRecorded: async () => {
          await assertRunCurrent();
          await context.checkpointState({
            ...context.state,
            pendingImplementationFindingDecisionSession: null,
          });
        },
      });
      return {
        kind: "continue",
        next: "resolve-implementation-review-findings",
        state: { pendingImplementationFindingDecisionSession: null },
        summary: boundedSummary(
          `Записаны решения по findings implementation review (${summarizeFindingDecisions(recorded.decisions)})`,
        ),
      };
    } catch (error) {
      return findingFailure(
        context,
        error,
        "Не удалось записать решения по implementation findings",
      );
    }
  }
  const session = work.session;

  try {
    const completed = await dependencies.findingResolution.run({
      workspaceDirectory: dependencies.workspaceDirectory,
      changeId: change.id,
      branch: activeBranch,
      profile: resolution.profile,
      session,
      taskScope,
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
        await assertRunCurrent();
        await context.checkpointState({
          ...context.state,
          pendingImplementationFindingResolutionSession: null,
        });
      },
    });

    if (completed.outcome === "blocked") {
      return {
        kind: "continue",
        next: "resolve-implementation-review-findings",
        state: { pendingImplementationFindingResolutionSession: null },
        summary: boundedSummary(
          `Implementation finding ${completed.findingId} возвращена к решению пользователя: ${completed.reason}`,
        ),
      };
    }
    if (completed.remainingFindingIds.length === 0) {
      return await finishFindings(
        dependencies,
        context,
        completed.commit,
        `Обработана последняя implementation finding ${completed.findingId}; обновлён PR #${completed.pullRequest.number}`,
      );
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

/**
 * Все implementation findings решены: implementation run переходит к
 * следующему пакету задач, планирование фазы — к финальной проверке.
 */
async function finishFindings(
  dependencies: ResolveImplementationReviewFindingsDependencies,
  context: WorkflowStepContext,
  headCommit: string,
  summary: string,
): Promise<WorkflowStepResult> {
  const implementationRun = context.state.implementationRun;
  if (implementationRun) {
    return await continueImplementationAfterFindings(
      dependencies,
      context,
      implementationRun,
      headCommit,
      summary,
    );
  }
  return {
    kind: "continue",
    next: "validate-phase-planning",
    state: {
      pendingImplementationFindingDecisionSession: null,
      pendingImplementationFindingResolutionSession: null,
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
  console.error("[OpenSpec] Ошибка устранения implementation review finding", {
    code: errorCode(error),
  });
  const summary =
    error instanceof ImplementationFindingResolutionError ||
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
  // Перед сохранением ещё раз проверяем, что review и findings не наполнили
  // фазы, которые планирует оркестратор.
  const decision = await inspectWithinTaskScope(
    dependencies.phaseWork,
    dependencies.workspaceDirectory,
    implementationRun.changeId,
    {
      kind: "implementation",
      phaseNumber: implementationRun.phaseNumber,
      baseline: previous,
    },
    context.signal,
  );
  return {
    kind: "continue",
    next: "execute-change-tasks",
    state: {
      phaseProgress: decision.progress,
      implementationRun: clearImplementationBatch(implementationRun, headCommit),
      pendingImplementationFindingDecisionSession: null,
      pendingImplementationFindingResolutionSession: null,
    },
    summary,
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

export function createResolveImplementationReviewFindingsStep(
  dependencies: ResolveImplementationReviewFindingsDependencies,
): WorkflowStepDefinition {
  return {
    id: "resolve-implementation-review-findings",
    label: "Устраняю findings implementation review",
    run: (context) => resolveImplementationReviewFindingsStep(dependencies, context),
  };
}
