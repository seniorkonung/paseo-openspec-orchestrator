import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
} from "../../agent-profiles.ts";
import { ChangeArtifactCreationError } from "../../change-artifact-creation.ts";
import { ChangePublicationError } from "../../change-publication.ts";
import { OpenSpecChangeError } from "../../openspec-change.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export async function publishChangeStep(
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { branch, change } = context.state;
  if (!branch || !change) {
    return {
      kind: "halt",
      summary: "Недостаточно данных для публикации change",
      message: "Git-ветка или OpenSpec change не сохранены; запустите workflow заново",
    };
  }

  try {
    const currentBranch = await context.services.gitBranch(
      context.workspaceDirectory,
      context.signal,
    );
    if (currentBranch.kind !== "non-main" || currentBranch.name !== branch) {
      return {
        kind: "halt",
        summary: "Git-ветка изменилась после начала workflow",
        message: `Вернитесь в ветку «${branch}» и нажмите «Повторить»`,
      };
    }
  } catch (error) {
    if (context.signal.aborted) throw error;
    console.error("[OpenSpec] Не удалось повторно проверить ветку перед публикацией", {
      code: errorCode(error),
    });
    return {
      kind: "halt",
      summary: "Не удалось повторно проверить Git-ветку",
      message: "Проверьте Git-ветку и нажмите «Повторить»",
    };
  }

  try {
    const worktree = await context.services.gitWorktree(
      context.workspaceDirectory,
      context.signal,
    );
    if (worktree.kind === "dirty") {
      return {
        kind: "halt",
        summary: "Рабочее дерево Git содержит изменения",
        message:
          "В рабочем дереве есть незакоммиченные или неотслеживаемые файлы; сохраните их отдельно и нажмите «Повторить»",
      };
    }
  } catch (error) {
    if (context.signal.aborted) throw error;
    console.error("[OpenSpec] Не удалось проверить рабочее дерево перед публикацией", {
      code: errorCode(error),
    });
    return {
      kind: "halt",
      summary: "Не удалось проверить чистоту рабочего дерева Git",
      message: "Проверьте Git workspace и нажмите «Повторить»",
    };
  }

  try {
    await context.services.changeSelection.verify(
      context.workspaceDirectory,
      change.id,
      context.signal,
    );
    const plan = await context.services.changeArtifacts.inspect(
      context.workspaceDirectory,
      change.id,
      context.signal,
    );
    if (plan.kind === "inconsistent") {
      return {
        kind: "halt",
        summary: plan.message,
        message: `${plan.message}; исправьте состояние change и нажмите «Повторить»`,
      };
    }
    if (plan.kind !== "complete") {
      return {
        kind: "halt",
        summary: `Planning change «${change.id}» больше не завершён`,
        message: "Восстановите planning-артефакты change и нажмите «Повторить»",
      };
    }
    await context.services.changeArtifacts.verifyApply(
      context.workspaceDirectory,
      change.id,
      plan.schemaName,
      context.signal,
    );
  } catch (error) {
    if (context.signal.aborted) throw error;
    const message =
      error instanceof OpenSpecChangeError || error instanceof ChangeArtifactCreationError
        ? error.message
        : "Не удалось подтвердить готовность OpenSpec change к публикации";
    return {
      kind: "halt",
      summary: message,
      message: `${message}; исправьте состояние change и нажмите «Повторить»`,
    };
  }

  let profiles;
  try {
    profiles = await context.services.readAgentProfiles();
  } catch (error) {
    if (context.signal.aborted) throw error;
    console.error("[OpenSpec] Не удалось перечитать профили перед публикацией", {
      code: errorCode(error),
    });
    return {
      kind: "halt",
      summary: "Не удалось перечитать профили агентов",
      message:
        "Не удалось перечитать профиль Medium Sandbox перед публикацией; проверьте Paseo и нажмите «Повторить»",
    };
  }

  const resolution = resolveRequiredAgentProfile(profiles, "Medium Sandbox");
  if (resolution.kind === "invalid") {
    const summary = describeRequiredAgentProfileProblem("Medium Sandbox", resolution);
    return {
      kind: "halt",
      summary,
      message: `${summary}; исправьте Agent profiles в Paseo и нажмите «Повторить»`,
    };
  }

  try {
    const publication = await context.services.changePublication.publish({
      workspaceDirectory: context.workspaceDirectory,
      changeId: change.id,
      branch,
      profile: resolution.profile,
      signal: context.signal,
      onAgentCreated: (agentId) => {
        context.updateActionLinks([
          {
            kind: "agent",
            agentId,
            label: `Публикация change ${change.id}`,
          },
        ]);
      },
    });
    return {
      kind: "continue",
      next: "review-change",
      state: {
        pendingArtifactSession: null,
        pendingReviewSession: null,
      },
      summary: `Pull request #${publication.number} опубликован: ${publication.url}`.slice(
        0,
        500,
      ),
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    console.error("[OpenSpec] Не удалось опубликовать change", {
      changeId: change.id,
      code: errorCode(error),
    });
    const summary =
      error instanceof ChangePublicationError
        ? error.message
        : "Не удалось опубликовать change и pull request";
    return {
      kind: "halt",
      summary,
      message: `${summary}; исправьте состояние Git или GitHub и нажмите «Повторить»`,
    };
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}

export const publishChange: WorkflowStepDefinition = {
  id: "publish-change",
  label: "Публикую change и pull request",
  run: publishChangeStep,
};
