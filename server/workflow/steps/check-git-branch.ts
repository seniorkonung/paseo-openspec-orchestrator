import type { GitBranchDecision } from "../../git-branch.ts";
import type {
  WorkflowStepDefinition,
  WorkflowStepContext,
  WorkflowStepResult,
} from "../types.ts";

function branchSummary(decision: GitBranchDecision): string {
  switch (decision.kind) {
    case "main":
      return "Git-ветка main — запуск запрещён";
    case "detached":
      return "Git-ветка не определена (detached HEAD)";
    case "non-main":
      return `Git-ветка: ${decision.name}`.slice(0, 500);
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}

export async function checkGitBranchStep(
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  let decision: GitBranchDecision;
  try {
    decision = await context.services.gitBranch(context.workspaceDirectory, context.signal);
  } catch (error) {
    console.error("[OpenSpec] Не удалось определить Git-ветку", {
      code: errorCode(error),
    });
    return {
      kind: "halt",
      summary: "Не удалось определить Git-ветку",
      message: "Не удалось определить Git-ветку; проверьте workspace и нажмите «Повторить»",
    };
  }

  switch (decision.kind) {
    case "main":
      return {
        kind: "halt",
        summary: branchSummary(decision),
        message: "Ветка main запрещена; переключите ветку и нажмите «Повторить»",
      };
    case "detached":
      return {
        kind: "halt",
        summary: branchSummary(decision),
        message:
          "Git-ветка не определена; создайте или переключите ветку и нажмите «Повторить»",
      };
    case "non-main":
      return {
        kind: "continue",
        state: { branch: decision.name },
        summary: branchSummary(decision),
      };
  }
}

export const checkGitBranch: WorkflowStepDefinition = {
  id: "check-git-branch",
  label: "Определяю Git-ветку",
  run: checkGitBranchStep,
};
