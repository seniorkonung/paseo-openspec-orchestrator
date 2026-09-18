import type { MiseToolchainDecision, MiseToolchainProbe } from "../../mise-toolchain.ts";
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

function haltFor(
  decision: Exclude<MiseToolchainDecision, { kind: "available" }>,
): WorkflowStepResult {
  if (decision.kind === "mise-unavailable") {
    return {
      kind: "halt",
      summary: "mise недоступен",
      message:
        "Команда mise недоступна; установите mise или добавьте её в PATH процесса Paseo и нажмите «Повторить»",
    };
  }

  switch (decision.reason) {
    case "not-configured":
      return {
        kind: "halt",
        summary: `${decision.tool.displayName} не настроен в mise текущего workspace`,
        message:
          `Добавьте ${decision.tool.miseName} в mise.toml текущего workspace, ` +
          "выполните mise install и нажмите «Повторить»",
      };
    case "not-installed":
      return {
        kind: "halt",
        summary: `${decision.tool.displayName} не установлен через mise`,
        message:
          `${decision.tool.displayName} настроен, но не скачан; выполните mise install ` +
          "в текущем workspace и нажмите «Повторить»",
      };
    case "unavailable":
      return {
        kind: "halt",
        summary: `${decision.tool.displayName} через mise недоступен`,
        message:
          `Не удалось проверить ${decision.tool.displayName} через mise; проверьте mise.toml, ` +
          "выполните mise install и нажмите «Повторить»",
      };
  }
}

export interface CheckMiseToolchainDependencies {
  readonly workspaceDirectory: string;
  readonly inspectToolchain: MiseToolchainProbe;
}

async function checkMiseToolchainStep(
  dependencies: CheckMiseToolchainDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  let decision: MiseToolchainDecision;
  try {
    decision = await dependencies.inspectToolchain(
      dependencies.workspaceDirectory,
      context.signal,
    );
  } catch (error) {
    console.error("[OpenSpec] Не удалось проверить mise toolchain", {
      code: errorCode(error),
    });
    return {
      kind: "halt",
      summary: "Не удалось проверить mise toolchain",
      message:
        "Не удалось проверить mise toolchain в текущем workspace; проверьте окружение и нажмите «Повторить»",
    };
  }

  if (decision.kind !== "available") return haltFor(decision);
  return {
    kind: "continue",
    next: "select-change",
    summary: "Mise toolchain доступен",
  };
}

export function createCheckMiseToolchainStep(
  dependencies: CheckMiseToolchainDependencies,
): WorkflowStepDefinition {
  return {
    id: "check-mise-toolchain",
    label: "Проверяю mise toolchain",
    run: (context) => checkMiseToolchainStep(dependencies, context),
  };
}
