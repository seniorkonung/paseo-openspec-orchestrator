import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
  type AgentProfileReader,
} from "../../agent-profiles.ts";
import {
  PhaseTaskPlanningError,
  type PhaseTaskPlanningService,
} from "../../phase-task-planning.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export interface PlanPhaseTasksDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly phaseTaskPlanning: PhaseTaskPlanningService;
}

async function planPhaseTasksStep(
  dependencies: PlanPhaseTasksDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { planningRun } = context.state;
  if (!planningRun) {
    return {
      kind: "halt",
      summary: "Planning-run не сохранён",
      message: "Запустите workflow заново из корневой change-ветки",
    };
  }
  let session = context.state.pendingPhaseTaskPlanningSession;
  try {
    if (!session) {
      session = await dependencies.phaseTaskPlanning.prepare(
        dependencies.workspaceDirectory,
        planningRun.changeId,
        planningRun.changeBranch,
        planningRun.planningBranch,
        planningRun.phaseNumber,
        planningRun.baselineProgress,
        context.signal,
      );
      await context.checkpointState({
        ...context.state,
        pendingPhaseTaskPlanningSession: session,
      });
    }
    const profiles = await dependencies.readAgentProfiles();
    const resolution = resolveRequiredAgentProfile(profiles, "Ultra Sandbox");
    if (resolution.kind === "invalid") {
      const summary = describeRequiredAgentProfileProblem("Ultra Sandbox", resolution);
      return { kind: "halt", summary, message: `${summary}; исправьте профиль и нажмите «Повторить»` };
    }
    const completed = await dependencies.phaseTaskPlanning.run({
      workspaceDirectory: dependencies.workspaceDirectory,
      profile: resolution.profile,
      session,
      signal: context.signal,
      onAgentCreated: (agentId) => context.updateActionLinks([{
        kind: "agent",
        agentId,
        label: `Планирование Phase ${planningRun.phaseNumber}`,
      }]),
      onCompleted: async (completion) => {
        await context.checkpointState({
          ...context.state,
          phaseProgress: completion.progress,
          // Сохраняем session до атомарного перехода шага. Если процесс
          // остановится после принятого commit, recovery проверит его и не
          // вызовет openspec-update-change повторно.
          pendingPhaseTaskPlanningSession: session,
        });
      },
    });
    return {
      kind: "continue",
      next: "publish-change",
      state: {
        phaseProgress: completed.progress,
        pendingPhaseTaskPlanningSession: null,
      },
      summary: `Задачи Phase ${planningRun.phaseNumber} запланированы`,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary = error instanceof PhaseTaskPlanningError
      ? error.message
      : "Не удалось запланировать задачи фазы";
    return { kind: "halt", summary, message: `${summary}; исправьте состояние и нажмите «Повторить»` };
  }
}

export function createPlanPhaseTasksStep(
  dependencies: PlanPhaseTasksDependencies,
): WorkflowStepDefinition {
  return {
    id: "plan-phase-tasks",
    label: "Планирую задачи следующей фазы",
    run: (context) => planPhaseTasksStep(dependencies, context),
  };
}
