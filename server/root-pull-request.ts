import { z } from "zod";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { changeBranchFor, changeBranchSchema } from "./change-branch.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  assertCleanReviewWorktree,
  listReviewPullRequests,
  readCurrentReviewBranch,
  readLocalReviewBranchCommit,
  readOptionalRemoteReviewBranchCommit,
  readReviewHeadCommit,
  readReviewPullRequest,
  resolveReviewRepository,
} from "./review-publication-gateway.ts";
import {
  assertPullRequestRepository,
  githubHostSchema,
  httpsUrlSchema,
  pullRequestNumberSchema,
  repositoryArgument,
  repositoryNameWithOwnerSchema,
} from "./review-publication-model.ts";

export const rootPullRequestIdentitySchema = z.object({
  number: pullRequestNumberSchema,
  url: httpsUrlSchema,
  repositoryHost: githubHostSchema,
  repositoryNameWithOwner: repositoryNameWithOwnerSchema,
  repositoryUrl: httpsUrlSchema,
  changeBranch: changeBranchSchema,
}).strict();

export type RootPullRequestIdentity = z.infer<typeof rootPullRequestIdentitySchema>;

export type RootPullRequestInspection =
  | { readonly kind: "open"; readonly isDraft: boolean; readonly head: string; readonly identity: RootPullRequestIdentity }
  | { readonly kind: "merged"; readonly head: string; readonly identity: RootPullRequestIdentity }
  | { readonly kind: "closed"; readonly head: string; readonly identity: RootPullRequestIdentity };

export interface RootPullRequestService {
  synchronize(
    workspaceDirectory: string,
    changeId: string,
    changeBranch: string,
    signal?: AbortSignal,
  ): Promise<string>;
  inspect(
    workspaceDirectory: string,
    changeId: string,
    changeBranch: string,
    previous: RootPullRequestIdentity | null,
    signal?: AbortSignal,
  ): Promise<RootPullRequestInspection>;
  makeDraft(
    workspaceDirectory: string,
    inspection: Extract<RootPullRequestInspection, { kind: "open" }>,
    signal?: AbortSignal,
  ): Promise<RootPullRequestInspection>;
  makeReady(
    workspaceDirectory: string,
    inspection: Extract<RootPullRequestInspection, { kind: "open" }>,
    signal?: AbortSignal,
  ): Promise<RootPullRequestInspection>;
}

export class RootPullRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RootPullRequestError";
  }
}

export function createRootPullRequestService(
  options: { readonly command?: BoundedCommandRunner } = {},
): RootPullRequestService {
  const command = options.command ?? runBoundedCommand;

  const inspect: RootPullRequestService["inspect"] = async (
    workspaceDirectory,
    changeIdInput,
    changeBranchInput,
    previousInput,
    signal,
  ) => {
    const changeId = openSpecChangeIdSchema.parse(changeIdInput);
    const changeBranch = changeBranchSchema.parse(changeBranchInput);
    if (changeBranch !== changeBranchFor(changeId)) {
      throw new RootPullRequestError("Корневая ветка не соответствует change");
    }
    const previous = previousInput === null
      ? null
      : rootPullRequestIdentitySchema.parse(previousInput);
    await assertCleanReviewWorktree(command, workspaceDirectory, signal);
    const [currentBranch, localHead, remoteHead, repository] = await Promise.all([
      readCurrentReviewBranch(command, workspaceDirectory, signal),
      readReviewHeadCommit(command, workspaceDirectory, signal),
      readOptionalRemoteReviewBranchCommit(command, workspaceDirectory, changeBranch, signal),
      resolveReviewRepository(command, workspaceDirectory, signal),
    ]);
    if (currentBranch !== changeBranch || (remoteHead !== null && localHead !== remoteHead)) {
      throw new RootPullRequestError("Корневая ветка должна быть активна и не расходиться с origin");
    }
    const pullRequests = await listReviewPullRequests(
      command,
      workspaceDirectory,
      repositoryArgument(repository),
      changeBranch,
      "all",
      signal,
    );
    if (pullRequests.length !== 1) {
      throw new RootPullRequestError("Для корневой ветки должен существовать ровно один pull request");
    }
    const pullRequest = await readReviewPullRequest(
      command,
      workspaceDirectory,
      repositoryArgument(repository),
      pullRequests[0]!.number,
      signal,
    );
    assertPullRequestRepository(pullRequest, repository.url);
    if (
      pullRequest.isCrossRepository ||
      pullRequest.baseRefName !== "main" ||
      pullRequest.headRefName !== changeBranch ||
      pullRequest.headRefOid !== localHead ||
      (pullRequest.state === "OPEN" && remoteHead === null)
    ) {
      throw new RootPullRequestError("Корневой pull request имеет неверные repository, base, head или commit");
    }
    const identity = rootPullRequestIdentitySchema.parse({
      number: pullRequest.number,
      url: pullRequest.url,
      repositoryHost: repository.host,
      repositoryNameWithOwner: repository.nameWithOwner,
      repositoryUrl: repository.url,
      changeBranch,
    });
    if (previous && JSON.stringify(previous) !== JSON.stringify(identity)) {
      throw new RootPullRequestError("Identity корневого pull request изменилась");
    }
    if (pullRequest.state === "MERGED") return { kind: "merged", head: localHead, identity };
    if (pullRequest.state === "CLOSED") return { kind: "closed", head: localHead, identity };
    return { kind: "open", isDraft: pullRequest.isDraft, head: localHead, identity };
  };

  const changeDraftState = async (
    workspaceDirectory: string,
    inspection: Extract<RootPullRequestInspection, { kind: "open" }>,
    ready: boolean,
    signal?: AbortSignal,
  ): Promise<RootPullRequestInspection> => {
    if (inspection.isDraft === !ready) return inspection;
    try {
      await command(
        "gh",
        [
          "pr",
          "ready",
          String(inspection.identity.number),
          "--repo",
          repositoryArgument({
            host: inspection.identity.repositoryHost,
            nameWithOwner: inspection.identity.repositoryNameWithOwner,
          }),
          ...(ready ? [] : ["--undo"]),
        ],
        { cwd: workspaceDirectory, signal },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RootPullRequestError(
        ready
          ? "Не удалось перевести корневой pull request в Ready"
          : "Не удалось вернуть корневой pull request в Draft",
      );
    }
    return inspect(
      workspaceDirectory,
      inspection.identity.changeBranch.slice("change/".length),
      inspection.identity.changeBranch,
      inspection.identity,
      signal,
    );
  };

  return {
    async synchronize(workspaceDirectory, changeIdInput, changeBranchInput, signal) {
      const changeId = openSpecChangeIdSchema.parse(changeIdInput);
      const changeBranch = changeBranchSchema.parse(changeBranchInput);
      if (changeBranch !== changeBranchFor(changeId)) {
        throw new RootPullRequestError("Корневая ветка не соответствует change");
      }
      await assertCleanReviewWorktree(command, workspaceDirectory, signal);
      if (await readCurrentReviewBranch(command, workspaceDirectory, signal) !== changeBranch) {
        throw new RootPullRequestError(`Перед проверкой должна быть активна ветка «${changeBranch}»`);
      }
      try {
        const [local, head, remote] = await Promise.all([
          readLocalReviewBranchCommit(command, workspaceDirectory, changeBranch, signal),
          readReviewHeadCommit(command, workspaceDirectory, signal),
          readOptionalRemoteReviewBranchCommit(command, workspaceDirectory, changeBranch, signal),
        ]);
        if (local === null) throw new Error("Локальная root-ветка отсутствует");
        // После финального merge GitHub может удалить remote branch. При
        // существующем remote не принимаем посторонний fast-forward.
        if (head !== local || (remote !== null && remote !== local)) {
          throw new Error("Локальный и удалённый HEAD расходятся");
        }
        return local;
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new RootPullRequestError(
          `Корневая ветка «${changeBranch}» расходится с origin или локальным HEAD`,
        );
      }
    },
    inspect,
    makeDraft: (workspaceDirectory, inspection, signal) =>
      changeDraftState(workspaceDirectory, inspection, false, signal),
    makeReady: (workspaceDirectory, inspection, signal) =>
      changeDraftState(workspaceDirectory, inspection, true, signal),
  };
}
