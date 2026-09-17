import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
} from "../../agent-profiles.ts";
import { ChangeArtifactCreationError } from "../../change-artifact-creation.ts";
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

export async function createChangeArtifactsStep(
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const change = context.state.change;
  if (!change) {
    return {
      kind: "halt",
      summary: "OpenSpec change не выбран",
      message: "OpenSpec change не выбран; запустите workflow заново",
    };
  }

  if (!context.state.pendingArtifactSession) {
    try {
      const currentPlan = await context.services.changeArtifacts.inspect(
        context.workspaceDirectory,
        change.id,
        context.signal,
      );
      if (currentPlan.kind === "inconsistent") {
        return {
          kind: "halt",
          summary: currentPlan.message,
          message: `${currentPlan.message}; исправьте состояние и нажмите «Повторить»`,
        };
      }
      if (currentPlan.kind === "complete") {
        await context.services.changeArtifacts.verifyApply(
          context.workspaceDirectory,
          change.id,
          currentPlan.schemaName,
          context.signal,
        );
        return {
          kind: "continue",
          next: "publish-change",
          state: { pendingArtifactSession: null },
          summary: `OpenSpec change готов к apply: ${change.id}`,
        };
      }
    } catch (error) {
      return artifactFailure(context, error, "Не удалось определить следующий артефакт");
    }
  }

  let profiles;
  try {
    profiles = await context.services.readAgentProfiles();
  } catch (error) {
    console.error("[OpenSpec] Не удалось перечитать профили перед созданием артефакта", {
      code: errorCode(error),
    });
    return {
      kind: "halt",
      summary: "Не удалось перечитать профили агентов",
      message:
        "Не удалось перечитать профили агентов перед созданием артефакта; проверьте Paseo и нажмите «Повторить»",
    };
  }

  const resolution = resolveRequiredAgentProfile(profiles, "Ultra Sandbox");
  if (resolution.kind === "invalid") {
    const summary = describeRequiredAgentProfileProblem("Ultra Sandbox", resolution);
    return {
      kind: "halt",
      summary,
      message: `${summary}; исправьте Agent profiles в Paseo и нажмите «Повторить»`,
    };
  }

  let session = context.state.pendingArtifactSession;
  if (!session) {
    try {
      session = await context.services.changeArtifacts.prepare(
        context.workspaceDirectory,
        change.id,
        context.signal,
      );
      await context.checkpointState({
        ...context.state,
        pendingArtifactSession: session,
      });
    } catch (error) {
      return artifactFailure(context, error, "Не удалось подготовить создание артефакта");
    }
  }

  try {
    const plan = await context.services.changeArtifacts.create({
      workspaceDirectory: context.workspaceDirectory,
      changeId: change.id,
      profile: resolution.profile,
      session,
      signal: context.signal,
      onAgentCreated: (agentId) => {
        context.updateActionLinks([
          {
            kind: "agent",
            agentId,
            label: `Артефакт ${session.artifactId}`,
          },
        ]);
      },
      onArtifactCompleted: async () => {
        await context.checkpointState({
          ...context.state,
          pendingArtifactSession: null,
        });
      },
    });

    if (plan.kind === "complete") {
      await context.services.changeArtifacts.verifyApply(
        context.workspaceDirectory,
        change.id,
        plan.schemaName,
        context.signal,
      );
      return {
        kind: "continue",
        next: "publish-change",
        state: { pendingArtifactSession: null },
        summary: `OpenSpec change готов к apply: ${change.id}`,
      };
    }
    return {
      kind: "continue",
      next: "create-change-artifacts",
      state: { pendingArtifactSession: null },
      summary: `Создан OpenSpec-артефакт: ${session.artifactId}`,
    };
  } catch (error) {
    return artifactFailure(context, error, "Не удалось завершить создание артефакта");
  }
}

function artifactFailure(
  context: WorkflowStepContext,
  error: unknown,
  fallback: string,
): WorkflowStepResult {
  if (context.signal.aborted) throw error;
  console.error("[OpenSpec] Ошибка создания planning-артефакта", {
    code: errorCode(error),
  });
  const summary = error instanceof ChangeArtifactCreationError ? error.message : fallback;
  return {
    kind: "halt",
    summary,
    message: `${summary}; исправьте состояние и нажмите «Повторить»`,
  };
}

export const createChangeArtifacts: WorkflowStepDefinition = {
  id: "create-change-artifacts",
  label: "Создаю OpenSpec-артефакт",
  run: createChangeArtifactsStep,
};
