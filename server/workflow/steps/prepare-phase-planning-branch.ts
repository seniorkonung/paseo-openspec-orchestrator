import { PlanningBranchError, type PlanningBranchService } from "../../planning-branch.ts";
import { planningRunSchema } from "../../planning-run-model.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export interface PreparePhasePlanningBranchDependencies {
  readonly workspaceDirectory: string;
  readonly planningBranch: PlanningBranchService;
}

async function preparePhasePlanningBranchStep(
  dependencies: PreparePhasePlanningBranchDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { change, changeBranch, activeBranch, phaseTarget, phaseProgress } = context.state;
  if (
    !change ||
    !changeBranch ||
    activeBranch !== changeBranch ||
    phaseTarget?.kind !== "planning" ||
    !phaseProgress
  ) {
    return {
      kind: "halt",
      summary: "Недостаточно данных для phase planning",
      message: "Целевая фаза или её сохранённый progress отсутствуют",
    };
  }
  let session = context.state.pendingPlanningBranchSession;
  try {
    if (!session) {
      session = await dependencies.planningBranch.prepare(
        dependencies.workspaceDirectory,
        change.id,
        changeBranch,
        { kind: "phase", phaseNumber: phaseTarget.phaseNumber },
        context.signal,
      );
      await context.checkpointState({
        ...context.state,
        pendingPlanningBranchSession: session,
      });
    }
    const planningBranch = await dependencies.planningBranch.activate(
      dependencies.workspaceDirectory,
      session,
      context.signal,
    );
    const planningRun = planningRunSchema.parse({
      changeId: change.id,
      changeBranch,
      planningBranch,
      phaseNumber: phaseTarget.phaseNumber,
      rootBaselineCommit: session.baselineCommit,
      baselineProgress: phaseProgress,
    });
    return {
      kind: "continue",
      next: "plan-phase-tasks",
      state: {
        activeBranch: planningBranch,
        planningRun,
        phaseTarget: null,
        pendingPlanningBranchSession: null,
      },
      summary: `Phase ${phaseTarget.phaseNumber} планируется в ${planningBranch}`,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary = error instanceof PlanningBranchError
      ? error.message
      : "Не удалось подготовить phase planning";
    return { kind: "halt", summary, message: `${summary}; исправьте состояние и нажмите «Повторить»` };
  }
}

export function createPreparePhasePlanningBranchStep(
  dependencies: PreparePhasePlanningBranchDependencies,
): WorkflowStepDefinition {
  return {
    id: "prepare-phase-planning-branch",
    label: "Проверяю корневую ветку перед планированием фазы",
    run: (context) => preparePhasePlanningBranchStep(dependencies, context),
  };
}
