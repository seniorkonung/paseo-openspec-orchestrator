import { setTimeout as delay } from "node:timers/promises";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { changeBranchFor } from "./change-branch.ts";
import { isCommitAncestor } from "./git-ancestry.ts";
import {
  assertCleanReviewWorktree,
  listReviewPullRequests,
  readCurrentReviewBranch,
  readRemoteReviewBranchCommit,
  readReviewHeadCommit,
  readReviewPullRequest,
  resolveReviewRepository,
} from "./review-publication-gateway.ts";
import {
  assertPullRequestRepository,
  repositoryArgument,
  type ReviewPullRequest,
} from "./review-publication-model.ts";
import type { RootPullRequestIdentity } from "./root-pull-request.ts";

export class RootBranchDeliveryError extends Error {
  constructor(message: string) { super(message); this.name = "RootBranchDeliveryError"; }
}

export interface RootCommitDeliveryOptions {
  /**
   * Коммиты этапа публикуются только в Draft PR. Принятые коммиты пользователя
   * могут публиковаться и после перевода PR в Ready.
   */
  readonly requireDraft?: boolean;
  readonly headWait?: PullRequestHeadWait;
}

/**
 * Как долго ждать, пока GitHub применит push к корневому PR. Ветка в origin
 * обновляется сразу, а head PR — асинхронно: обычно через несколько секунд,
 * при сбоях GitHub дольше.
 */
export interface PullRequestHeadWait {
  /** Общий предел ожидания за одну публикацию; повторный вызов ждёт заново. */
  readonly timeoutMs: number;
  /** Первая пауза между чтениями PR; дальше она удваивается до `maxDelayMs`. */
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_PULL_REQUEST_HEAD_WAIT: PullRequestHeadWait = Object.freeze({
  timeoutMs: 30_000,
  initialDelayMs: 500,
  maxDelayMs: 4_000,
  now: () => performance.now(),
  sleep: (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }),
});

// Коммит проверяется вызывающим этапом. Эта граница публикует только проверенный
// HEAD и только fast-forward: origin может указывать на любой предок HEAD, но
// никогда не перезаписывается.
export async function deliverRootCommit(
  workspaceDirectory: string,
  changeId: string,
  baselineInput: string,
  headInput: string,
  signal?: AbortSignal,
  command: BoundedCommandRunner = runBoundedCommand,
  expectedPullRequest?: RootPullRequestIdentity,
  options: RootCommitDeliveryOptions = {},
): Promise<void> {
  const requireDraft = options.requireDraft ?? true;
  const baseline = commitHashSchema.parse(baselineInput);
  const head = commitHashSchema.parse(headInput);
  const branch = changeBranchFor(changeId);
  await assertCleanReviewWorktree(command, workspaceDirectory, signal);
  const [current, local, remote, repository] = await Promise.all([
    readCurrentReviewBranch(command, workspaceDirectory, signal),
    readReviewHeadCommit(command, workspaceDirectory, signal),
    readRemoteReviewBranchCommit(command, workspaceDirectory, branch, signal),
    resolveReviewRepository(command, workspaceDirectory, signal),
  ]);
  if (current !== branch || local !== head) {
    throw new RootBranchDeliveryError("Корневая ветка изменилась перед публикацией коммита");
  }
  if (!(await isCommitAncestor(command, workspaceDirectory, remote, head, signal))) {
    throw new RootBranchDeliveryError(
      "Origin корневой ветки содержит коммиты, которых нет в локальной ветке",
    );
  }
  if (!(await isCommitAncestor(command, workspaceDirectory, baseline, head, signal))) {
    throw new RootBranchDeliveryError("Новый коммит не происходит от сохранённого baseline");
  }
  const requests = await listReviewPullRequests(command, workspaceDirectory, repositoryArgument(repository), branch, "all", signal);
  if (requests.length !== 1) throw new RootBranchDeliveryError("Для change требуется ровно один корневой PR");
  const pr = await readReviewPullRequest(command, workspaceDirectory, repositoryArgument(repository), requests[0]!.number, signal);
  const assertDeliverable = (request: ReviewPullRequest): void => {
    assertPullRequestRepository(request, repository.url);
    if (request.number !== pr.number || request.state !== "OPEN" || (requireDraft && !request.isDraft) ||
        request.isCrossRepository || request.baseRefName !== "main" || request.headRefName !== branch) {
      throw new RootBranchDeliveryError(
        requireDraft
          ? "Корневой PR изменился или уже не находится в Draft"
          : "Корневой PR изменился или уже закрыт",
      );
    }
  };
  assertDeliverable(pr);
  if (expectedPullRequest && (
    expectedPullRequest.changeBranch !== branch ||
    expectedPullRequest.number !== pr.number || expectedPullRequest.url !== pr.url ||
    expectedPullRequest.repositoryHost !== repository.host ||
    expectedPullRequest.repositoryNameWithOwner.toLowerCase() !== repository.nameWithOwner.toLowerCase() ||
    expectedPullRequest.repositoryUrl !== repository.url
  )) throw new RootBranchDeliveryError("Identity корневого PR изменилась до публикации коммита");
  if (remote !== head) {
    try {
      await command("git", ["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: workspaceDirectory, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RootBranchDeliveryError("Не удалось безопасно опубликовать коммит в корневой ветке");
    }
    const remoteAfter = await readRemoteReviewBranchCommit(command, workspaceDirectory, branch, signal);
    if (remoteAfter !== head) throw new RootBranchDeliveryError("Origin корневой ветки не подтвердил опубликованный коммит");
  }
  // HEAD уже в origin, в том числе при повторном вызове после push. Head PR
  // догоняет его с задержкой, поэтому PR перечитывается до совпадения.
  const wait = options.headWait ?? DEFAULT_PULL_REQUEST_HEAD_WAIT;
  const deadline = wait.now() + wait.timeoutMs;
  let pause = wait.initialDelayMs;
  let latest = pr;
  while (latest.headRefOid !== head) {
    const remaining = deadline - wait.now();
    if (remaining <= 0) {
      console.warn("[OpenSpec] GitHub не обновил head корневого PR после push", {
        pullRequest: pr.number,
        expectedHead: head,
        actualHead: latest.headRefOid,
        waitedMs: wait.timeoutMs,
      });
      throw new RootBranchDeliveryError(
        `GitHub не обновил корневой PR #${pr.number} до коммита ${head.slice(0, 12)} ` +
          `за ${Math.ceil(wait.timeoutMs / 1_000)} с; коммит уже опубликован в origin, повторите позже`,
      );
    }
    await wait.sleep(Math.min(pause, remaining), signal);
    pause = Math.min(pause * 2, wait.maxDelayMs);
    latest = await readReviewPullRequest(command, workspaceDirectory, repositoryArgument(repository), pr.number, signal);
    assertDeliverable(latest);
  }
}
