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
import { assertPullRequestRepository, repositoryArgument } from "./review-publication-model.ts";
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
}

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
  assertPullRequestRepository(pr, repository.url);
  if (expectedPullRequest && (
    expectedPullRequest.changeBranch !== branch ||
    expectedPullRequest.number !== pr.number || expectedPullRequest.url !== pr.url ||
    expectedPullRequest.repositoryHost !== repository.host ||
    expectedPullRequest.repositoryNameWithOwner.toLowerCase() !== repository.nameWithOwner.toLowerCase() ||
    expectedPullRequest.repositoryUrl !== repository.url
  )) throw new RootBranchDeliveryError("Identity корневого PR изменилась до публикации коммита");
  if (pr.state !== "OPEN" || (requireDraft && !pr.isDraft) || pr.isCrossRepository ||
      pr.baseRefName !== "main" || pr.headRefName !== branch || pr.headRefOid !== remote) {
    throw new RootBranchDeliveryError(
      requireDraft
        ? "Корневой PR изменился или уже не находится в Draft"
        : "Корневой PR изменился или уже закрыт",
    );
  }
  if (remote === head) return;
  try {
    await command("git", ["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: workspaceDirectory, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new RootBranchDeliveryError("Не удалось безопасно опубликовать коммит в корневой ветке");
  }
  const [remoteAfter, prAfter] = await Promise.all([
    readRemoteReviewBranchCommit(command, workspaceDirectory, branch, signal),
    readReviewPullRequest(command, workspaceDirectory, repositoryArgument(repository), pr.number, signal),
  ]);
  assertPullRequestRepository(prAfter, repository.url);
  if (remoteAfter !== head || prAfter.state !== "OPEN" || (requireDraft && !prAfter.isDraft) ||
      prAfter.isCrossRepository || prAfter.baseRefName !== "main" ||
      prAfter.headRefName !== branch || prAfter.headRefOid !== head ||
      prAfter.number !== pr.number) {
    throw new RootBranchDeliveryError("Публикация коммита не подтверждена GitHub");
  }
}
