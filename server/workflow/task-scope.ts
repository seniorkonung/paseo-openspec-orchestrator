import {
  PhaseWorkError,
  plannedPhaseNumbers,
  type PhaseTaskScope,
  type PhaseWorkService,
} from "../phase-work.ts";
import type { WorkflowState, WorkflowStepContext } from "./types.ts";

/**
 * Область задач агентских этапов в текущей стадии workflow.
 *
 * Implementation run и планирование фазы берут baseline из своего durable
 * run-состояния. Начальное планирование использует фазы с задачами,
 * сохранённые перед первым агентским этапом review.
 */
export function workflowTaskScope(state: WorkflowState): PhaseTaskScope {
  const { implementationRun, planningRun } = state;
  if (implementationRun) {
    if (!state.phaseProgress) {
      throw new PhaseWorkError("Не сохранён baseline задач implementation-run");
    }
    return {
      kind: "implementation",
      phaseNumber: implementationRun.phaseNumber,
      baseline: state.phaseProgress,
    };
  }
  if (planningRun) {
    return {
      kind: "phase-planning",
      phaseNumber: planningRun.phaseNumber,
      baseline: planningRun.baselineProgress,
    };
  }
  if (!state.initialPlannedPhases) {
    throw new PhaseWorkError("Не сохранены фазы с задачами начального планирования");
  }
  return { kind: "initial-planning", plannedPhases: state.initialPlannedPhases };
}

/**
 * Сохраняет фазы с задачами перед первым агентским этапом начального
 * планирования и возвращает актуальное состояние шага.
 *
 * `context.state` фиксируется на старте шага, поэтому последующие checkpoint
 * шага должны строиться от возвращённого состояния, иначе baseline потеряется.
 */
export async function ensureInitialPlannedPhases(
  phaseWork: Pick<PhaseWorkService, "inspect">,
  workspaceDirectory: string,
  changeId: string,
  context: WorkflowStepContext,
): Promise<WorkflowState> {
  const { state } = context;
  if (state.implementationRun || state.planningRun || state.initialPlannedPhases) {
    return state;
  }
  const decision = await phaseWork.inspect(workspaceDirectory, changeId, null, context.signal);
  const nextState: WorkflowState = {
    ...state,
    initialPlannedPhases: plannedPhaseNumbers(decision),
  };
  await context.checkpointState(nextState);
  return nextState;
}
