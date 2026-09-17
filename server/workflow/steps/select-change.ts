import {
  describeRequiredAgentProfileProblems,
  resolveRequiredAgentProfiles,
} from "../../agent-profiles.ts";
import { ChangeArtifactCreationError } from "../../change-artifact-creation.ts";
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

export async function selectChangeStep(
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  let change: OrchestratorChange;
  if (context.state.change) {
    try {
      change = await context.services.changeSelection.verify(
        context.workspaceDirectory,
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
      profiles = await context.services.readAgentProfiles();
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
      change = await context.services.changeSelection.select({
        workspaceDirectory: context.workspaceDirectory,
        profile: resolution.profiles["Medium Sandbox"],
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
    const plan = await context.services.changeArtifacts.inspect(
      context.workspaceDirectory,
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
    await context.services.changeArtifacts.verifyApply(
      context.workspaceDirectory,
      change.id,
      plan.schemaName,
      context.signal,
    );
    return {
      kind: "complete",
      state: { change, pendingArtifactSession: null },
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

export const selectChange: WorkflowStepDefinition = {
  id: "select-change",
  label: "Выбираю OpenSpec change",
  run: selectChangeStep,
};
