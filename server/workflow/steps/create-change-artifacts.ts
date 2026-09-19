import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
  type AgentProfileReader,
} from "../../agent-profiles.ts";
import {
  ChangeArtifactCreationError,
  type ChangeArtifactCreationService,
} from "../../change-artifact-creation.ts";
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

export interface CreateChangeArtifactsDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly changeArtifacts: Pick<
    ChangeArtifactCreationService,
    "inspect" | "prepare" | "create" | "verifyApply"
  >;
}

async function runCreateChangeArtifactsStep(
  dependencies: CreateChangeArtifactsDependencies,
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
      const currentPlan = await dependencies.changeArtifacts.inspect(
        dependencies.workspaceDirectory,
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
        await dependencies.changeArtifacts.verifyApply(
          dependencies.workspaceDirectory,
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
    profiles = await dependencies.readAgentProfiles();
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

  const resolution = resolveRequiredAgentProfile(profiles, "Ultra");
  if (resolution.kind === "invalid") {
    const summary = describeRequiredAgentProfileProblem("Ultra", resolution);
    return {
      kind: "halt",
      summary,
      message: `${summary}; исправьте Agent profiles в Paseo и нажмите «Повторить»`,
    };
  }

  let session = context.state.pendingArtifactSession;
  if (!session) {
    try {
      session = await dependencies.changeArtifacts.prepare(
        dependencies.workspaceDirectory,
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
    const plan = await dependencies.changeArtifacts.create({
      workspaceDirectory: dependencies.workspaceDirectory,
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
      await dependencies.changeArtifacts.verifyApply(
        dependencies.workspaceDirectory,
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

export function createChangeArtifactsStep(
  dependencies: CreateChangeArtifactsDependencies,
): WorkflowStepDefinition {
  return {
    id: "create-change-artifacts",
    label: "Создаю OpenSpec-артефакт",
    run: (context) => runCreateChangeArtifactsStep(dependencies, context),
  };
}
