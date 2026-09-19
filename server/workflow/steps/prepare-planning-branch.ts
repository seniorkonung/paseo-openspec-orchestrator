import {
  PlanningBranchError,
  type PlanningBranchService,
} from "../../planning-branch.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export interface PreparePlanningBranchDependencies {
  readonly workspaceDirectory: string;
  readonly planningBranch: PlanningBranchService;
}

async function preparePlanningBranchStep(
  dependencies: PreparePlanningBranchDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { change, changeBranch, activeBranch } = context.state;
  if (!change || !changeBranch || activeBranch !== changeBranch) {
    return {
      kind: "halt",
      summary: "Недостаточно данных для planning-ветки",
      message: "Change или его корневая ветка не сохранены; запустите workflow заново",
    };
  }
  let session = context.state.pendingPlanningBranchSession;
  try {
    if (!session) {
      session = await dependencies.planningBranch.prepare(
        dependencies.workspaceDirectory,
        change.id,
        changeBranch,
        { kind: "initial" },
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
    return {
      kind: "continue",
      next: "inspect-change",
      state: {
        activeBranch: planningBranch,
        pendingPlanningBranchSession: null,
      },
      summary: `Planning-ветка создана: ${planningBranch}`,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary =
      error instanceof PlanningBranchError
        ? error.message
        : "Не удалось подготовить planning-ветку";
    return {
      kind: "halt",
      summary,
      message: `${summary}; исправьте состояние Git или GitHub и нажмите «Повторить»`,
    };
  }
}

export function createPreparePlanningBranchStep(
  dependencies: PreparePlanningBranchDependencies,
): WorkflowStepDefinition {
  return {
    id: "prepare-planning-branch",
    label: "Подготавливаю planning-ветку",
    run: (context) => preparePlanningBranchStep(dependencies, context),
  };
}
