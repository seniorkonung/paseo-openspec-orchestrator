import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import {
  assertCleanTaskWorktree,
  assertTaskCommitDescendsFrom,
  readCurrentTaskBranch,
  readLocalTaskBranchCommit,
  readRemoteTaskBranchCommit,
  readTaskGitRoot,
  readTaskHeadCommit,
  resolveTaskRepository,
} from "./change-task-gateway.ts";
import {
  implementationRunSchema,
  type ImplementationRun,
} from "./implementation-run-model.ts";
import {
  assertImplementationPullRequest,
  renderImplementationSummary,
  replaceImplementationSummary,
} from "./implementation-publication.ts";
import { readReviewPullRequest } from "./review-publication-gateway.ts";
import { repositoryArgument } from "./review-publication-model.ts";

export interface ImplementationRunVerifier {
  assertCurrent(
    workspaceDirectory: string,
    run: ImplementationRun,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface ImplementationRunVerifierOptions {
  readonly command?: BoundedCommandRunner;
}

export class ImplementationRunVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImplementationRunVerificationError";
  }
}

export function createImplementationRunVerifier(
  options: ImplementationRunVerifierOptions = {},
): ImplementationRunVerifier {
  const command = options.command ?? runBoundedCommand;

  return {
    async assertCurrent(workspaceDirectory, runInput, signal) {
      const run = implementationRunSchema.parse(runInput);
      try {
        const gitRoot = await readTaskGitRoot(command, workspaceDirectory, signal);
        await assertCleanTaskWorktree(command, gitRoot, signal);
        const [
          branch,
          head,
          localRoot,
          remoteRoot,
          remoteImplementation,
          repository,
        ] = await Promise.all([
          readCurrentTaskBranch(command, gitRoot, signal),
          readTaskHeadCommit(command, gitRoot, signal),
          readLocalTaskBranchCommit(command, gitRoot, run.changeBranch, signal),
          readRemoteTaskBranchCommit(command, gitRoot, run.changeBranch, signal),
          readRemoteTaskBranchCommit(command, gitRoot, run.implementationBranch, signal),
          resolveTaskRepository(command, gitRoot, signal),
        ]);
        if (branch !== run.implementationBranch) {
          throw new ImplementationRunVerificationError(
            `Текущей должна быть implementation-ветка «${run.implementationBranch}»`,
          );
        }
        if (
          localRoot !== run.rootBaselineCommit ||
          remoteRoot !== run.rootBaselineCommit
        ) {
          throw new ImplementationRunVerificationError(
            `Root baseline ветки «${run.changeBranch}» изменился`,
          );
        }
        if (remoteImplementation !== head) {
          throw new ImplementationRunVerificationError(
            "Local и origin implementation-ветки должны указывать на один commit",
          );
        }
        if (
          repository.host !== run.repository.host ||
          repository.nameWithOwner.toLowerCase() !==
            run.repository.nameWithOwner.toLowerCase() ||
          repository.url !== run.repository.url
        ) {
          throw new ImplementationRunVerificationError(
            "GitHub repository identity изменилась во время implementation-run",
          );
        }
        await assertTaskCommitDescendsFrom(
          command,
          gitRoot,
          run.rootBaselineCommit,
          head,
          "Implementation HEAD не продолжает root baseline",
          signal,
        );
        if (run.publication.kind !== "unpublished") {
          const pullRequest = await readReviewPullRequest(
            command,
            gitRoot,
            repositoryArgument(run.repository),
            run.publication.number,
            signal,
          );
          assertImplementationPullRequest(pullRequest, run, head, true);
          replaceImplementationSummary(
            pullRequest.body,
            renderImplementationSummary(run),
          );
        }
        return head;
      } catch (error) {
        if (error instanceof ImplementationRunVerificationError || signal?.aborted) {
          throw error;
        }
        throw new ImplementationRunVerificationError(
          "Не удалось подтвердить неизменность implementation-run",
        );
      }
    },
  };
}
