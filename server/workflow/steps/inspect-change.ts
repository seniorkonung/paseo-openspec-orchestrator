import {
  ChangeArtifactCreationError,
  type ChangeArtifactCreationService,
} from "../../change-artifact-creation.ts";
import {
  OpenSpecChangeError,
  type OpenSpecChangeVerifier,
} from "../../openspec-change.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export interface InspectChangeDependencies {
  readonly workspaceDirectory: string;
  readonly verifyChange: OpenSpecChangeVerifier;
  readonly changeArtifacts: Pick<ChangeArtifactCreationService, "inspect" | "verifyApply">;
}

async function inspectChangeStep(
  dependencies: InspectChangeDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { change, activeBranch } = context.state;
  if (!change || !activeBranch) {
    return {
      kind: "halt",
      summary: "OpenSpec change или активная ветка не сохранены",
      message: "Запустите workflow заново из корневой change-ветки",
    };
  }
  try {
    const verified = await dependencies.verifyChange(
      dependencies.workspaceDirectory,
      change.id,
      context.signal,
    );
    const plan = await dependencies.changeArtifacts.inspect(
      dependencies.workspaceDirectory,
      verified.id,
      context.signal,
    );
    if (plan.kind === "next-artifact") {
      return {
        kind: "continue",
        next: "create-change-artifacts",
        state: { change: verified },
        summary: `Следующий артефакт OpenSpec change: ${plan.artifactId}`,
      };
    }
    if (plan.kind === "inconsistent") {
      return {
        kind: "halt",
        summary: plan.message,
        message: `${plan.message}; исправьте состояние change и нажмите «Повторить»`,
      };
    }
    await dependencies.changeArtifacts.verifyApply(
      dependencies.workspaceDirectory,
      verified.id,
      plan.schemaName,
      context.signal,
    );
    return {
      kind: "continue",
      next: "publish-change",
      state: { change: verified },
      summary: `OpenSpec change готов к apply: ${verified.id}`,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary =
      error instanceof OpenSpecChangeError || error instanceof ChangeArtifactCreationError
        ? error.message
        : "Не удалось проверить OpenSpec change";
    return {
      kind: "halt",
      summary,
      message: `${summary}; исправьте состояние change и нажмите «Повторить»`,
    };
  }
}

export function createInspectChangeStep(
  dependencies: InspectChangeDependencies,
): WorkflowStepDefinition {
  return {
    id: "inspect-change",
    label: "Проверяю OpenSpec change",
    run: (context) => inspectChangeStep(dependencies, context),
  };
}
