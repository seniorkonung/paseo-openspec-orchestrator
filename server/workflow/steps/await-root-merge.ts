import type { ChangeArchiveService } from "../../change-archive.ts";
import { ChangeArchiveError } from "../../change-archive-model.ts";
import { RootPullRequestError, type RootPullRequestService } from "../../root-pull-request.ts";
import type { WorkflowStepContext, WorkflowStepDefinition, WorkflowStepResult } from "../types.ts";

export interface AwaitRootMergeDependencies {
  readonly workspaceDirectory: string;
  readonly archive: Pick<ChangeArchiveService, "verifyArchived">;
  readonly rootPullRequest: RootPullRequestService;
}

async function awaitRootMerge(dependencies: AwaitRootMergeDependencies, context: WorkflowStepContext): Promise<WorkflowStepResult> {
  const { change, changeBranch, activeBranch, archivedChange, rootPullRequest } = context.state;
  if (!change || !changeBranch || activeBranch !== changeBranch || !archivedChange || !rootPullRequest) {
    return { kind: "halt", summary: "Не сохранена архивация change", message: "Перед финальным merge нужен проверенный архивный коммит" };
  }
  try {
    await dependencies.archive.verifyArchived(dependencies.workspaceDirectory, archivedChange, context.signal);
    const head = await dependencies.rootPullRequest.synchronize(dependencies.workspaceDirectory, change.id, changeBranch, context.signal);
    if (head !== archivedChange.commit) throw new ChangeArchiveError("Корневая ветка изменилась после архивации");
    let pr = await dependencies.rootPullRequest.inspect(dependencies.workspaceDirectory, change.id, changeBranch, rootPullRequest, context.signal);
    if (pr.head !== archivedChange.commit) throw new ChangeArchiveError("HEAD корневого PR изменился после архивации");
    if (pr.kind === "closed") throw new RootPullRequestError("Корневой pull request закрыт без merge");
    if (pr.kind === "merged") return { kind: "complete", summary: `Change ${change.id} архивирован, корневой PR слит` };
    if (pr.isDraft) {
      pr = await dependencies.rootPullRequest.makeReady(dependencies.workspaceDirectory, pr, context.signal);
      if (pr.kind === "closed" || pr.head !== archivedChange.commit) throw new RootPullRequestError("Корневой PR изменился при переводе в Ready");
      if (pr.kind === "merged") return { kind: "complete", summary: `Change ${change.id} архивирован, корневой PR слит` };
      if (pr.isDraft) throw new RootPullRequestError("Корневой pull request не перешёл в Ready");
    }
    await dependencies.archive.verifyArchived(dependencies.workspaceDirectory, archivedChange, context.signal);
    const finalHead = await dependencies.rootPullRequest.synchronize(dependencies.workspaceDirectory, change.id, changeBranch, context.signal);
    const finalPr = await dependencies.rootPullRequest.inspect(dependencies.workspaceDirectory, change.id, changeBranch, pr.identity, context.signal);
    if (finalHead !== archivedChange.commit || finalPr.head !== archivedChange.commit) throw new ChangeArchiveError("HEAD изменился после Ready");
    if (finalPr.kind === "merged") return { kind: "complete", summary: `Change ${change.id} архивирован, корневой PR слит` };
    if (finalPr.kind === "closed") throw new RootPullRequestError("Корневой pull request закрыт без merge");
    if (finalPr.isDraft) throw new RootPullRequestError("Корневой pull request вернулся в Draft");
    return { kind: "halt", summary: `Корневой PR #${finalPr.identity.number} ожидает merge`, message: `Выполните merge ${finalPr.identity.url}, затем нажмите «Повторить»` };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary = error instanceof ChangeArchiveError || error instanceof RootPullRequestError ? error.message : "Не удалось проверить архив и корневой PR";
    return { kind: "halt", summary, message: `${summary}; исправьте состояние и нажмите «Повторить»` };
  }
}

export function createAwaitRootMergeStep(dependencies: AwaitRootMergeDependencies): WorkflowStepDefinition {
  return { id: "await-root-merge", label: "Проверяю архив и ожидаю merge корневого PR", run: (context) => awaitRootMerge(dependencies, context) };
}
