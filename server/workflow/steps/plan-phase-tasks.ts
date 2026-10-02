import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
  type AgentProfileReader,
} from "../../agent-profiles.ts";
import {
  PhaseTaskPlanningError,
  type PhaseTaskPlanningService,
} from "../../phase-task-planning.ts";
import { planningRunSchema } from "../../planning-run-model.ts";
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
  // Состояние, от которого строятся checkpoint шага: baseline run следует за
  // baseline новой сессии.
  let state = context.state;
  try {
    if (!session) {
      const plan = await dependencies.phaseTaskPlanning.prepare(
        dependencies.workspaceDirectory,
        planningRun.changeId,
        planningRun.changeBranch,
        planningRun.planningBranch,
        planningRun.phaseNumber,
        planningRun.baselineProgress,
        context.signal,
      );
      if (plan.kind === "already-planned") {
        return {
          kind: "continue",
          next: "publish-change",
          state: { phaseProgress: plan.progress, pendingPhaseTaskPlanningSession: null },
          summary: `Задачи Phase ${planningRun.phaseNumber} уже есть в репозитории`,
        };
      }
      session = plan.session;
      state = {
        ...context.state,
        // Планирование начинается с текущего HEAD: коммиты, появившиеся после
        // подготовки run, входят в его baseline.
        planningRun: planningRunSchema.parse({
          ...planningRun,
          rootBaselineCommit: session.baselineCommit,
        }),
        pendingPhaseTaskPlanningSession: session,
      };
      await context.checkpointState(state);
    }
    const profiles = await dependencies.readAgentProfiles();
    const resolution = resolveRequiredAgentProfile(profiles, "Ultra");
    if (resolution.kind === "invalid") {
      const summary = describeRequiredAgentProfileProblem("Ultra", resolution);
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
          ...state,
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
        planningRun: state.planningRun,
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
