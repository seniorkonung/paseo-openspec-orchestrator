import {
  describeRequiredAgentProfileProblems,
  resolveRequiredAgentProfiles,
  type AgentProfileReader,
} from "../../agent-profiles.ts";
import {
  ChangeArtifactCreationError,
  type ChangeArtifactCreationService,
} from "../../change-artifact-creation.ts";
import type { ChangeSelectionService } from "../../change-selection.ts";
import { OpenSpecChangeError } from "../../openspec-change.ts";
import type { OrchestratorChange } from "../../../shared/orchestrator.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}

export interface SelectChangeDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly changeSelection: Pick<ChangeSelectionService, "verify" | "select">;
  readonly changeArtifacts: Pick<ChangeArtifactCreationService, "inspect" | "verifyApply">;
}

async function selectChangeStep(
  dependencies: SelectChangeDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  let change: OrchestratorChange;
  if (context.state.change) {
    try {
      change = await dependencies.changeSelection.verify(
        dependencies.workspaceDirectory,
        context.state.change.id,
        context.signal,
      );
    } catch (error) {
      if (context.signal.aborted) throw error;
      const message =
        error instanceof OpenSpecChangeError
          ? error.message
          : "Не удалось повторно проверить выбранный OpenSpec change";
      return {
        kind: "halt",
        summary: message,
        message: `${message}; исправьте состояние change и нажмите «Повторить»`,
      };
    }
  } else {
    let profiles;
    try {
      profiles = await dependencies.readAgentProfiles();
    } catch (error) {
      console.error("[OpenSpec] Не удалось перечитать профили перед выбором change", {
        code: errorCode(error),
      });
      return {
        kind: "halt",
        summary: "Не удалось перечитать профили агентов",
        message:
          "Не удалось перечитать профили агентов перед выбором change; проверьте Paseo и нажмите «Повторить»",
      };
    }

    const resolution = resolveRequiredAgentProfiles(profiles);
    if (resolution.kind === "invalid") {
      const summary = describeRequiredAgentProfileProblems(resolution);
      return {
        kind: "halt",
        summary,
        message: `${summary}; исправьте Agent profiles в Paseo и нажмите «Повторить»`,
      };
    }

    try {
      change = await dependencies.changeSelection.select({
        workspaceDirectory: dependencies.workspaceDirectory,
        profile: resolution.profiles["Low Sandbox"],
        signal: context.signal,
        onAgentCreated: (agentId) => {
          context.updateActionLinks([
            { kind: "agent", agentId, label: "Выбор OpenSpec change" },
          ]);
        },
        onChangeSelected: (selectedChange) =>
          context.checkpointState({
            ...context.state,
            change: selectedChange,
            pendingArtifactSession: null,
            pendingReviewSession: null,
          }),
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      console.error("[OpenSpec] Не удалось завершить выбор change", {
        code: errorCode(error),
      });
      return {
        kind: "halt",
        summary: "Не удалось выбрать OpenSpec change",
        message:
          "Не удалось запустить или завершить диалог выбора OpenSpec change; нажмите «Повторить»",
      };
    }
  }

  try {
    const plan = await dependencies.changeArtifacts.inspect(
      dependencies.workspaceDirectory,
      change.id,
      context.signal,
    );
    if (plan.kind === "next-artifact") {
      return {
        kind: "continue",
        next: "create-change-artifacts",
        state: { change },
        summary: `Выбран OpenSpec change: ${change.id}`,
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
      change.id,
      plan.schemaName,
      context.signal,
    );
    return {
      kind: "continue",
      next: "publish-change",
      state: {
        change,
        pendingArtifactSession: null,
        pendingReviewSession: null,
      },
      summary: `OpenSpec change готов к apply: ${change.id}`,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const message =
      error instanceof ChangeArtifactCreationError
        ? error.message
        : "Не удалось определить следующий этап OpenSpec change";
    return {
      kind: "halt",
      summary: message,
      message: `${message}; исправьте состояние change и нажмите «Повторить»`,
    };
  }
}

export function createSelectChangeStep(
  dependencies: SelectChangeDependencies,
): WorkflowStepDefinition {
  return {
    id: "select-change",
    label: "Выбираю OpenSpec change",
    run: (context) => selectChangeStep(dependencies, context),
  };
}
