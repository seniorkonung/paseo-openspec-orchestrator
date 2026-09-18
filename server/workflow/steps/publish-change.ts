import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
  type AgentProfileReader,
} from "../../agent-profiles.ts";
import {
  ChangeArtifactCreationError,
  type ChangeArtifactCreationService,
} from "../../change-artifact-creation.ts";
import {
  ChangePublicationError,
  type ChangePublicationService,
} from "../../change-publication.ts";
import type { GitBranchProbe } from "../../git-branch.ts";
import type { GitWorktreeProbe } from "../../git-worktree.ts";
import {
  OpenSpecChangeError,
  type OpenSpecChangeVerifier,
} from "../../openspec-change.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export interface PublishChangeDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly inspectBranch: GitBranchProbe;
  readonly inspectWorktree: GitWorktreeProbe;
  readonly verifyChange: OpenSpecChangeVerifier;
  readonly changeArtifacts: Pick<ChangeArtifactCreationService, "inspect" | "verifyApply">;
  readonly changePublication: Pick<ChangePublicationService, "publish">;
}

async function publishChangeStep(
  dependencies: PublishChangeDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { changeBranch, activeBranch, change } = context.state;
  if (!changeBranch || !activeBranch || !change) {
    return {
      kind: "halt",
      summary: "Недостаточно данных для публикации change",
      message: "Git-ветка или OpenSpec change не сохранены; запустите workflow заново",
    };
  }

  try {
    const currentBranch = await dependencies.inspectBranch(
      dependencies.workspaceDirectory,
      context.signal,
    );
    if (currentBranch.kind !== "non-main" || currentBranch.name !== activeBranch) {
      return {
        kind: "halt",
        summary: "Git-ветка изменилась после начала workflow",
        message: `Вернитесь в ветку «${activeBranch}» и нажмите «Повторить»`,
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
    const worktree = await dependencies.inspectWorktree(
      dependencies.workspaceDirectory,
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
    await dependencies.verifyChange(
      dependencies.workspaceDirectory,
      change.id,
      context.signal,
    );
    const plan = await dependencies.changeArtifacts.inspect(
      dependencies.workspaceDirectory,
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
    await dependencies.changeArtifacts.verifyApply(
      dependencies.workspaceDirectory,
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
    profiles = await dependencies.readAgentProfiles();
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
    const publication = await dependencies.changePublication.publish({
      workspaceDirectory: dependencies.workspaceDirectory,
      changeId: change.id,
      changeBranch,
      activeBranch,
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

export function createPublishChangeStep(
  dependencies: PublishChangeDependencies,
): WorkflowStepDefinition {
  return {
    id: "publish-change",
    label: "Публикую change и pull request",
    run: (context) => publishChangeStep(dependencies, context),
  };
}
