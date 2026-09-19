import {
  PlanningMergeError,
  type PlanningMergeService,
} from "../../planning-merge.ts";
import type { OpenSpecChangeVerifier } from "../../openspec-change.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export interface AwaitPlanningMergeDependencies {
  readonly workspaceDirectory: string;
  readonly planningMerge: PlanningMergeService;
  readonly verifyChange: OpenSpecChangeVerifier;
}

async function awaitPlanningMergeStep(
  dependencies: AwaitPlanningMergeDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { change, changeBranch, activeBranch } = context.state;
  if (!change || !changeBranch || !activeBranch) {
    return {
      kind: "halt",
      summary: "Недостаточно данных для merge planning PR",
      message: "Change или его Git-ветки не сохранены; запустите workflow заново",
    };
  }

  let session = context.state.pendingPlanningMergeSession;
  try {
    if (!session) {
      const inspection = await dependencies.planningMerge.inspect(
        dependencies.workspaceDirectory,
        change.id,
        changeBranch,
        activeBranch,
        context.signal,
      );
      if (inspection.kind === "open") {
        return {
          kind: "halt",
          summary: `Planning PR #${inspection.pullRequest.number} ожидает merge`,
          message:
            `Выполните merge ${inspection.pullRequest.url}, затем нажмите «Повторить»`,
        };
      }
      session = inspection.session;
      await context.checkpointState({
        ...context.state,
        pendingPlanningMergeSession: session,
      });
    }

    const rootBranch = await dependencies.planningMerge.complete(
      dependencies.workspaceDirectory,
      session,
      context.signal,
    );
    await dependencies.verifyChange(
      dependencies.workspaceDirectory,
      change.id,
      context.signal,
    );
    return {
      kind: "continue",
      next: "prepare-implementation-branch",
      state: {
        activeBranch: rootBranch,
        pendingPlanningMergeSession: null,
      },
      summary: `Planning PR слит; workflow продолжен из ${rootBranch}`,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary =
      error instanceof PlanningMergeError
        ? error.message
        : "Не удалось подтвердить merge planning PR";
    return {
      kind: "halt",
      summary,
      message: `${summary}; исправьте состояние Git или GitHub и нажмите «Повторить»`,
    };
  }
}

export function createAwaitPlanningMergeStep(
  dependencies: AwaitPlanningMergeDependencies,
): WorkflowStepDefinition {
  return {
    id: "await-planning-merge",
    label: "Ожидаю merge planning pull request",
    run: (context) => awaitPlanningMergeStep(dependencies, context),
  };
}
