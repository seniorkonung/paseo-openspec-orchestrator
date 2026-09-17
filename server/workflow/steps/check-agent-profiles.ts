import { resolveRequiredAgentProfiles } from "../../agent-profiles.ts";
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

export async function checkAgentProfilesStep(
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  let profiles;
  try {
    profiles = await context.services.readAgentProfiles();
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
    const problems: string[] = [];
    if (resolution.missing.length > 0) {
      problems.push(`Отсутствуют профили агентов: ${resolution.missing.join(", ")}`);
    }
    if (resolution.ambiguous.length > 0) {
      problems.push(`Неоднозначные профили агентов: ${resolution.ambiguous.join(", ")}`);
    }
    const summary = problems.join("; ");
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

export const checkAgentProfiles: WorkflowStepDefinition = {
  id: "check-agent-profiles",
  label: "Проверяю профили агентов",
  run: checkAgentProfilesStep,
};
