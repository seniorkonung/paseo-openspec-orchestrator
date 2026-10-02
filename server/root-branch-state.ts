import { z } from "zod";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { changeBranchSchema } from "./change-branch.ts";
import { findNearestAncestor, isCommitAncestor, isKnownCommit } from "./git-ancestry.ts";
import { readOptionalRemoteReviewBranchCommit } from "./review-publication-gateway.ts";
import { deliverRootCommit } from "./root-branch-delivery.ts";

/** Положение origin относительно локального HEAD корневой ветки. */
export type RootBranchOrigin =
  /** Ветки ещё нет в origin, либо GitHub удалил её после merge. */
  | { readonly kind: "absent" }
  | { readonly kind: "synchronized" }
  /** Origin — предок HEAD: локальные коммиты можно опубликовать fast-forward. */
  | { readonly kind: "unpublished"; readonly remoteHead: string; readonly commits: number }
  /** HEAD — предок origin: локальная ветка отстаёт. */
  | { readonly kind: "behind"; readonly remoteHead: string }
  /** Истории разошлись: локальная ветка переписана относительно origin. */
  | { readonly kind: "diverged"; readonly remoteHead: string }
  /** Коммит origin неизвестен локальному репозиторию: он ещё не получен. */
  | { readonly kind: "unfetched"; readonly remoteHead: string };

export type RootBranchPosition =
  /**
   * Корневая ветка не активна или рабочее дерево не чистое. В таком состоянии
   * репозиторий нельзя ни сравнивать с сохранённым состоянием, ни публиковать.
   */
  | { readonly kind: "unavailable"; readonly reason: "other-branch" | "dirty-worktree" }
  | { readonly kind: "available"; readonly head: string; readonly origin: RootBranchOrigin };

/**
 * Наблюдение и fast-forward публикация корневой ветки change.
 *
 * Сервис никогда не переписывает origin и не меняет локальную ветку. Ошибка
 * чтения Git или GitHub завершает операцию исключением; расхождение историй —
 * это обычный результат `inspect`, а не ошибка.
 */
export interface RootBranchService {
  inspect(
    workspaceDirectory: string,
    changeBranch: string,
    signal?: AbortSignal,
  ): Promise<RootBranchPosition>;
  /**
   * Публикует локальный `head` поверх `remoteHead`. Требует единственный открытый
   * корневой PR; Draft не обязателен, потому что публикуются принятые коммиты
   * пользователя, а не результат этапа. При отказе бросает
   * `RootBranchDeliveryError` с причиной.
   */
  publish(
    workspaceDirectory: string,
    changeId: string,
    remoteHead: string,
    head: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Для каждого коммита возвращает ближайший к нему коммит истории `head`: сам
   * коммит, пока он остаётся предком, иначе общий предок. `null` — общей
   * истории нет или коммит неизвестен локальному репозиторию.
   */
  nearestAncestors(
    workspaceDirectory: string,
    commits: readonly string[],
    head: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string | null>>;
}

export interface RootBranchServiceOptions {
  readonly command?: BoundedCommandRunner;
}

export function createRootBranchService(
  options: RootBranchServiceOptions = {},
): RootBranchService {
  const command = options.command ?? runBoundedCommand;

  const readOrigin = async (
    workspaceDirectory: string,
    changeBranch: string,
    head: string,
    signal?: AbortSignal,
  ): Promise<RootBranchOrigin> => {
    const remoteHead = await readOptionalRemoteReviewBranchCommit(
      command,
      workspaceDirectory,
      changeBranch,
      signal,
    );
    if (remoteHead === null) return { kind: "absent" };
    if (remoteHead === head) return { kind: "synchronized" };
    if (await isCommitAncestor(command, workspaceDirectory, remoteHead, head, signal)) {
      const { stdout } = await command(
        "git",
        ["rev-list", "--count", `${remoteHead}..${head}`],
        { cwd: workspaceDirectory, signal },
      );
      return {
        kind: "unpublished",
        remoteHead,
        commits: z.coerce.number().int().positive().parse(stdout.trim()),
      };
    }
    if (await isCommitAncestor(command, workspaceDirectory, head, remoteHead, signal)) {
      return { kind: "behind", remoteHead };
    }
    return (await isKnownCommit(command, workspaceDirectory, remoteHead, signal))
      ? { kind: "diverged", remoteHead }
      : { kind: "unfetched", remoteHead };
  };

  return {
    async inspect(workspaceDirectory, changeBranchInput, signal) {
      const changeBranch = changeBranchSchema.parse(changeBranchInput);
      const current = await command("git", ["branch", "--show-current"], {
        cwd: workspaceDirectory,
        signal,
      });
      if (current.stdout.trim() !== changeBranch) {
        return { kind: "unavailable", reason: "other-branch" };
      }
      const status = await command(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: workspaceDirectory, signal },
      );
      if (status.stdout.length > 0) {
        return { kind: "unavailable", reason: "dirty-worktree" };
      }
      const head = commitHashSchema.parse(
        (await command("git", ["rev-parse", "HEAD"], { cwd: workspaceDirectory, signal }))
          .stdout.trim(),
      );
      return {
        kind: "available",
        head,
        origin: await readOrigin(workspaceDirectory, changeBranch, head, signal),
      };
    },

    async publish(workspaceDirectory, changeId, remoteHead, head, signal) {
      await deliverRootCommit(
        workspaceDirectory,
        changeId,
        remoteHead,
        head,
        signal,
        command,
        undefined,
        { requireDraft: false },
      );
    },

    async nearestAncestors(workspaceDirectory, commits, head, signal) {
      const nearest = new Map<string, string | null>();
      for (const commit of new Set(commits)) {
        nearest.set(
          commit,
          await findNearestAncestor(command, workspaceDirectory, commit, head, signal),
        );
      }
      return nearest;
    },
  };
}
