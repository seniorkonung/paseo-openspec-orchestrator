import type { GitBranchDecision, GitBranchProbe } from "../../git-branch.ts";
import { ChangeBranchError, parseChangeBranch } from "../../change-branch.ts";
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

export interface CheckGitBranchDependencies {
  readonly workspaceDirectory: string;
  readonly inspectBranch: GitBranchProbe;
}

async function checkGitBranchStep(
  dependencies: CheckGitBranchDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  let decision: GitBranchDecision;
  try {
    decision = await dependencies.inspectBranch(
      dependencies.workspaceDirectory,
      context.signal,
    );
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
      try {
        const changeBranch = parseChangeBranch(decision.name);
        return {
          kind: "continue",
          next: "check-git-worktree",
          state: {
            changeBranch,
            activeBranch: changeBranch,
          },
          summary: `Корневая change-ветка: ${changeBranch}`,
        };
      } catch (error) {
        if (!(error instanceof ChangeBranchError)) throw error;
        return {
          kind: "halt",
          summary: error.message,
          message:
            "Переключитесь на корневую ветку change/<change-id> и нажмите «Повторить»",
        };
      }
  }
}

export function createCheckGitBranchStep(
  dependencies: CheckGitBranchDependencies,
): WorkflowStepDefinition {
  return {
    id: "check-git-branch",
    label: "Определяю Git-ветку",
    run: (context) => checkGitBranchStep(dependencies, context),
  };
}
