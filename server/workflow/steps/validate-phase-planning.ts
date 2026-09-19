import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { runBoundedCommand, type BoundedCommandRunner } from "../../bounded-command.ts";
import {
  assertCleanTaskWorktree,
  assertTaskCommitDescendsFrom,
  readCurrentTaskBranch,
  readTaskChangedPaths,
  readTaskGitRoot,
  readTaskHeadCommit,
} from "../../change-task-gateway.ts";
import { ChangeTaskExecutionError } from "../../change-task-model.ts";
import { PhaseWorkError, type PhaseWorkService } from "../../phase-work.ts";
import {
  PhaseTaskPlanningError,
  assertPhasePlanningDecision,
} from "../../phase-task-planning.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export interface ValidatePhasePlanningDependencies {
  readonly workspaceDirectory: string;
  readonly phaseWork: PhaseWorkService;
  readonly command?: BoundedCommandRunner;
}

async function validatePhasePlanningStep(
  dependencies: ValidatePhasePlanningDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { planningRun } = context.state;
  if (!planningRun) {
    return { kind: "halt", summary: "Planning-run не сохранён", message: "Запустите workflow заново" };
  }
  try {
    const command = dependencies.command ?? runBoundedCommand;
    const gitRoot = await readTaskGitRoot(
      command,
      dependencies.workspaceDirectory,
      context.signal,
    );
    await assertCleanTaskWorktree(command, gitRoot, context.signal);
    if (await readCurrentTaskBranch(command, gitRoot, context.signal) !== planningRun.planningBranch) {
      throw new PhaseTaskPlanningError("Перед финальной проверкой должна быть активна planning-ветка фазы");
    }
    const head = await readTaskHeadCommit(command, gitRoot, context.signal);
    await assertTaskCommitDescendsFrom(
      command,
      gitRoot,
      planningRun.rootBaselineCommit,
      head,
      "Phase planning больше не продолжает root baseline",
      context.signal,
    );
    const decision = await dependencies.phaseWork.inspect(
      dependencies.workspaceDirectory,
      planningRun.changeId,
      planningRun.baselineProgress,
      context.signal,
    );
    assertPhasePlanningDecision(
      decision,
      planningRun.baselineProgress,
      planningRun.phaseNumber,
    );
    const changeRoot = dirname(decision.snapshot.planPath);
    const allowedPaths = [
      ...decision.snapshot.taskArtifactPaths,
      resolve(changeRoot, "review.md"),
      resolve(changeRoot, "implementation-review.md"),
    ].map((path) => repositoryPath(gitRoot, path));
    const changedPaths = await readTaskChangedPaths(
      command,
      gitRoot,
      planningRun.rootBaselineCommit,
      head,
      context.signal,
    );
    assertPhasePlanningChangedPaths(changedPaths, allowedPaths);
    return {
      kind: "continue",
      next: "await-planning-merge",
      state: { phaseProgress: decision.progress },
      summary: `Задачи Phase ${planningRun.phaseNumber} согласованы после review и resolver-циклов`,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary =
      error instanceof PhaseWorkError ||
      error instanceof PhaseTaskPlanningError ||
      error instanceof ChangeTaskExecutionError
      ? error.message
      : "Не удалось проверить задачи после review";
    return { kind: "halt", summary, message: `${summary}; исправьте состояние и нажмите «Повторить»` };
  }
}

export function assertPhasePlanningChangedPaths(
  changedPaths: readonly string[],
  allowedPaths: readonly string[],
): void {
  const allowed = new Set(allowedPaths);
  const unexpected = changedPaths.find((path) => !allowed.has(path));
  if (unexpected) {
    throw new PhaseTaskPlanningError(
      `Phase planning изменил недопустимый файл «${unexpected}»`,
    );
  }
}

function repositoryPath(gitRoot: string, candidate: string): string {
  const path = relative(gitRoot, candidate);
  if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new PhaseTaskPlanningError("Артефакт phase planning находится вне Git-репозитория");
  }
  return path.split(sep).join("/");
}

export function createValidatePhasePlanningStep(
  dependencies: ValidatePhasePlanningDependencies,
): WorkflowStepDefinition {
  return {
    id: "validate-phase-planning",
    label: "Проверяю задачи фазы после resolver-циклов",
    run: (context) => validatePhasePlanningStep(dependencies, context),
  };
}
