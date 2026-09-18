import {
  ChangeInitializationError,
  type ChangeInitializationService,
} from "../../change-initialization.ts";
import { changeIdFromBranch } from "../../change-branch.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export interface InitializeChangeDependencies {
  readonly workspaceDirectory: string;
  readonly changeInitialization: ChangeInitializationService;
}

async function initializeChangeStep(
  dependencies: InitializeChangeDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { changeBranch, activeBranch } = context.state;
  if (!changeBranch || activeBranch !== changeBranch) {
    return {
      kind: "halt",
      summary: "Корневая change-ветка не сохранена",
      message: "Запустите workflow заново из ветки change/<change-id>",
    };
  }
  const changeId = changeIdFromBranch(changeBranch);
  let session = context.state.pendingChangeInitializationSession;
  try {
    if (!session) {
      session = await dependencies.changeInitialization.prepare(
        dependencies.workspaceDirectory,
        changeId,
        changeBranch,
        context.signal,
      );
      await context.checkpointState({
        ...context.state,
        pendingChangeInitializationSession: session,
      });
    }
    const initialized = await dependencies.changeInitialization.initialize(
      dependencies.workspaceDirectory,
      session,
      context.signal,
    );
    return {
      kind: "continue",
      next: "prepare-planning-branch",
      state: {
        change: initialized.change,
        changeBranch: initialized.changeBranch,
        activeBranch: initialized.changeBranch,
        pendingChangeInitializationSession: null,
      },
      summary:
        `Change ${initialized.change.id} опубликован в корневом PR ` +
        `#${initialized.pullRequest.number}: ${initialized.pullRequest.url}`,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary =
      error instanceof ChangeInitializationError
        ? error.message
        : "Не удалось инициализировать OpenSpec change";
    return {
      kind: "halt",
      summary,
      message: `${summary}; исправьте состояние Git, OpenSpec или GitHub и нажмите «Повторить»`,
    };
  }
}

export function createInitializeChangeStep(
  dependencies: InitializeChangeDependencies,
): WorkflowStepDefinition {
  return {
    id: "initialize-change",
    label: "Инициализирую change и корневой pull request",
    run: (context) => initializeChangeStep(dependencies, context),
  };
}
