import {
  describeRequiredAgentProfileProblems,
  resolveRequiredAgentProfiles,
} from "../../agent-profiles.ts";
import type { AgentProfileReader } from "../../agent-profiles.ts";
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

export interface CheckAgentProfilesDependencies {
  readonly readAgentProfiles: AgentProfileReader;
}

async function checkAgentProfilesStep(
  dependencies: CheckAgentProfilesDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  let profiles;
  try {
    profiles = await dependencies.readAgentProfiles();
  } catch (error) {
    console.error("[OpenSpec] Не удалось получить профили агентов из Paseo", {
      code: errorCode(error),
    });
    return {
      kind: "halt",
      summary: "Не удалось получить профили агентов из Paseo",
      message:
        "Не удалось получить профили агентов из Paseo; проверьте подключение и нажмите «Повторить»",
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

  return {
    kind: "continue",
    next: "check-git-branch",
    summary: "Все обязательные профили агентов доступны",
  };
}

export function createCheckAgentProfilesStep(
  dependencies: CheckAgentProfilesDependencies,
): WorkflowStepDefinition {
  return {
    id: "check-agent-profiles",
    label: "Проверяю профили агентов",
    run: (context) => checkAgentProfilesStep(dependencies, context),
  };
}
