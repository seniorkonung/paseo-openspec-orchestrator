import type { GitWorktreeDecision } from "../../git-worktree.ts";
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

function worktreeSummary(decision: GitWorktreeDecision): string {
  return decision.kind === "clean"
    ? "Рабочее дерево Git чистое"
    : "Рабочее дерево Git содержит изменения";
}

export async function checkGitWorktreeStep(
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  let decision: GitWorktreeDecision;
  try {
    decision = await context.services.gitWorktree(
      context.workspaceDirectory,
      context.signal,
    );
  } catch (error) {
    console.error("[OpenSpec] Не удалось проверить рабочее дерево Git", {
      code: errorCode(error),
    });
    return {
      kind: "halt",
      summary: "Не удалось проверить рабочее дерево Git",
      message:
        "Не удалось проверить состояние рабочего дерева Git; проверьте workspace и нажмите «Повторить»",
    };
  }

  if (decision.kind === "dirty") {
    return {
      kind: "halt",
      summary: worktreeSummary(decision),
      message:
        "В рабочем дереве есть незакоммиченные или неотслеживаемые изменения; сохраните их отдельно и нажмите «Повторить»",
    };
  }

  return {
    kind: "complete",
    summary: worktreeSummary(decision),
  };
}

export const checkGitWorktree: WorkflowStepDefinition = {
  id: "check-git-worktree",
  label: "Проверяю чистоту рабочего дерева",
  run: checkGitWorktreeStep,
};
