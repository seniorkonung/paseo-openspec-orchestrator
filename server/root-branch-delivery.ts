import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { changeBranchFor } from "./change-branch.ts";
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

export class RootBranchDeliveryError extends Error {
  constructor(message: string) { super(message); this.name = "RootBranchDeliveryError"; }
}

// Коммит проверяется вызывающим этапом. Эта граница публикует только проверенный
// HEAD и никогда не перезаписывает неожиданное продвижение origin.
export async function deliverRootCommit(
  workspaceDirectory: string,
  changeId: string,
  baselineInput: string,
  headInput: string,
  signal?: AbortSignal,
  command: BoundedCommandRunner = runBoundedCommand,
): Promise<void> {
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
  if (current !== branch || local !== head || (remote !== baseline && remote !== head)) {
    throw new RootBranchDeliveryError("Корневая ветка или origin изменились после сохранённого baseline");
  }
  if (baseline !== head) {
    try {
      await command("git", ["merge-base", "--is-ancestor", baseline, head], { cwd: workspaceDirectory, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RootBranchDeliveryError("Новый коммит не происходит от сохранённого baseline");
    }
  }
  const requests = await listReviewPullRequests(command, workspaceDirectory, repositoryArgument(repository), branch, "all", signal);
  if (requests.length !== 1) throw new RootBranchDeliveryError("Для change требуется ровно один корневой PR");
  const pr = await readReviewPullRequest(command, workspaceDirectory, repositoryArgument(repository), requests[0]!.number, signal);
  assertPullRequestRepository(pr, repository.url);
  if (pr.state !== "OPEN" || !pr.isDraft || pr.isCrossRepository ||
      pr.baseRefName !== "main" || pr.headRefName !== branch || pr.headRefOid !== remote) {
    throw new RootBranchDeliveryError("Корневой PR изменился или уже не находится в Draft");
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
  if (remoteAfter !== head || prAfter.state !== "OPEN" || !prAfter.isDraft ||
      prAfter.isCrossRepository || prAfter.baseRefName !== "main" ||
      prAfter.headRefName !== branch || prAfter.headRefOid !== head ||
      prAfter.number !== pr.number) {
    throw new RootBranchDeliveryError("Публикация коммита не подтверждена GitHub");
  }
}
