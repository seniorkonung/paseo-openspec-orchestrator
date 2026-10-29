import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
  type AgentProfileReader,
  type RequiredAgentProfileName,
} from "../../agent-profiles.ts";
import { ChangeTaskExecutionError } from "../../change-task-model.ts";
import { extendImplementationBatch } from "../../implementation-run-model.ts";
import { RootBranchDeliveryError } from "../../root-branch-delivery.ts";
import type { TaskProfileService } from "../../task-profile-assessment.ts";
import { TaskProfilesError, summarizeTaskProfiles } from "../../task-profile-model.ts";
import { boundedMessage, boundedSummary } from "../bounded-text.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

/** Оценку выполняет сильнейший профиль: ошибка оценки дороже самой оценки. */
const ASSESSMENT_PROFILE = "High" satisfies RequiredAgentProfileName;

export interface AssessTaskProfilesDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly taskProfiles: Pick<TaskProfileService, "inspect" | "run">;
}

async function assessTaskProfilesStep(
  dependencies: AssessTaskProfilesDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { activeBranch, change, implementationRun } = context.state;
  if (!activeBranch || !change || !implementationRun) {
    return {
      kind: "halt",
      summary: "Недостаточно данных для оценки профилей задач",
      message: "Git-ветка, OpenSpec change или implementation-run не сохранены; запустите workflow заново",
    };
  }
  if (
    context.state.pendingArtifactSession ||
    context.state.pendingReviewSession ||
    context.state.pendingFindingDecisionSession ||
    context.state.pendingFindingResolutionSession ||
    context.state.pendingImplementationFindingDecisionSession ||
    context.state.pendingImplementationFindingResolutionSession ||
    context.state.pendingTaskExecutionSession ||
    context.state.pendingImplementationReviewSession
  ) {
    return {
      kind: "halt",
      summary: "Другая незавершённая сессия блокирует оценку профилей задач",
      message: "Завершите предыдущую агентскую сессию и запустите workflow заново",
    };
  }
  if (implementationRun.batch.kind === "reviewed") {
    // Проверенный пакет ждёт findings: задачи, которые они добавят, оценит
    // следующий пакет.
    return {
      kind: "continue",
      next: "resolve-implementation-review-findings",
      state: { pendingTaskProfileAssessmentSession: null },
      summary: "Implementation review пакета уже завершён: workflow переходит к его findings",
    };
  }
  const { phaseNumber } = implementationRun;

  let session = context.state.pendingTaskProfileAssessmentSession;
  if (!session) {
    try {
      const inspection = await dependencies.taskProfiles.inspect(
        dependencies.workspaceDirectory,
        implementationRun,
        context.signal,
      );
      if (inspection.kind === "assessed") {
        return {
          kind: "continue",
          next: "execute-change-tasks",
          summary: `Профили всех незавершённых задач Phase ${phaseNumber} уже назначены`,
        };
      }
      session = inspection.session;
      await context.checkpointState({
        ...context.state,
        pendingTaskProfileAssessmentSession: session,
      });
    } catch (error) {
      return assessmentFailure(context, error, "Не удалось определить задачи для оценки профилей");
    }
  }

  let profiles;
  try {
    profiles = await dependencies.readAgentProfiles();
  } catch (error) {
    if (context.signal.aborted) throw error;
    console.error("[OpenSpec] Не удалось перечитать профили перед оценкой задач", {
      code: errorCode(error),
    });
    return {
      kind: "halt",
      summary: "Не удалось перечитать профили агентов",
      message:
        `Не удалось перечитать профиль ${ASSESSMENT_PROFILE} перед оценкой задач; проверьте Paseo и нажмите «Повторить»`,
    };
  }
  const resolution = resolveRequiredAgentProfile(profiles, ASSESSMENT_PROFILE);
  if (resolution.kind === "invalid") {
    const summary = describeRequiredAgentProfileProblem(ASSESSMENT_PROFILE, resolution);
    return {
      kind: "halt",
      summary,
      message: `${summary}; исправьте Agent profiles в Paseo и нажмите «Повторить»`,
    };
  }

  try {
    const recorded = await dependencies.taskProfiles.run({
      workspaceDirectory: dependencies.workspaceDirectory,
      profile: resolution.profile,
      session,
      signal: context.signal,
      onAgentCreated: (agentId) => {
        context.updateActionLinks([
          { kind: "agent", agentId, label: `Оценка профилей задач Phase ${phaseNumber}` },
        ]);
      },
      onProfilesRecorded: async (result) => {
        await context.checkpointState({
          ...context.state,
          implementationRun: extendImplementationBatch(implementationRun, result.commit),
          pendingTaskProfileAssessmentSession: null,
        });
      },
    });
    return {
      kind: "continue",
      next: "execute-change-tasks",
      state: {
        implementationRun: extendImplementationBatch(implementationRun, recorded.commit),
        pendingTaskProfileAssessmentSession: null,
      },
      summary: boundedSummary(
        `Профили задач Phase ${phaseNumber} назначены: ${summarizeTaskProfiles(recorded.records)}`,
      ),
    };
  } catch (error) {
    return assessmentFailure(context, error, "Не удалось оценить профили OpenSpec-задач");
  }
}

function assessmentFailure(
  context: WorkflowStepContext,
  error: unknown,
  fallback: string,
): WorkflowStepResult {
  if (context.signal.aborted) throw error;
  console.error("[OpenSpec] Ошибка оценки профилей OpenSpec-задач", {
    code: errorCode(error),
  });
  const reason =
    error instanceof TaskProfilesError ||
    error instanceof ChangeTaskExecutionError ||
    error instanceof RootBranchDeliveryError
      ? error.message
      : fallback;
  return {
    kind: "halt",
    summary: boundedSummary(reason),
    message: boundedMessage(`${reason}; исправьте состояние и нажмите «Повторить»`),
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}

export function createAssessTaskProfilesStep(
  dependencies: AssessTaskProfilesDependencies,
): WorkflowStepDefinition {
  return {
    id: "assess-task-profiles",
    label: "Оцениваю профили OpenSpec-задач",
    run: (context) => assessTaskProfilesStep(dependencies, context),
  };
}
