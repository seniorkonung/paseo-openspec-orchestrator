import {
  ImplementationBranchError,
  type ImplementationBranchService,
} from "../../implementation-branch.ts";
import type { WorkflowStepContext, WorkflowStepDefinition, WorkflowStepResult } from "../types.ts";

export interface PrepareImplementationBranchDependencies {
  readonly workspaceDirectory: string;
  readonly implementationBranch: ImplementationBranchService;
}

async function runStep(
  dependencies: PrepareImplementationBranchDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { change, changeBranch, activeBranch, phaseTarget } = context.state;
  if (
    !change ||
    !changeBranch ||
    activeBranch !== changeBranch ||
    phaseTarget?.kind !== "implementation"
  ) {
    return { kind: "halt", summary: "Недостаточно данных для implementation-ветки", message: "Change или его корневая ветка не сохранены" };
  }
  let session = context.state.pendingImplementationBranchSession;
  try {
    if (!session) {
      session = await dependencies.implementationBranch.prepare(
        dependencies.workspaceDirectory,
        change.id,
        changeBranch,
        phaseTarget.phaseNumber,
        phaseTarget.runNumber,
        context.signal,
      );
      await context.checkpointState({
        ...context.state,
        pendingImplementationBranchSession: session,
      });
    }
    const run = await dependencies.implementationBranch.activate(
      dependencies.workspaceDirectory,
      session,
      context.signal,
    );
    return {
      kind: "continue",
      next: "execute-change-tasks",
      state: {
        activeBranch: run.implementationBranch,
        implementationRun: run,
        phaseTarget: null,
        pendingImplementationBranchSession: null,
      },
      summary: `Подготовлена implementation-ветка Phase ${run.phaseNumber}, run ${run.runNumber}: ${run.implementationBranch}`,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary = error instanceof ImplementationBranchError
      ? error.message
      : "Не удалось подготовить implementation-ветку";
    return { kind: "halt", summary, message: `${summary}; исправьте состояние и нажмите «Повторить»` };
  }
}

export function createPrepareImplementationBranchStep(
  dependencies: PrepareImplementationBranchDependencies,
): WorkflowStepDefinition {
  return { id: "prepare-implementation-branch", label: "Подготавливаю implementation-ветку", run: (context) => runStep(dependencies, context) };
}
