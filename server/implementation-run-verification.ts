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
import { createRootPullRequestService } from "./root-pull-request.ts";

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
  const rootPullRequest = createRootPullRequestService({ command });

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
          repository,
        ] = await Promise.all([
          readCurrentTaskBranch(command, gitRoot, signal),
          readTaskHeadCommit(command, gitRoot, signal),
          readLocalTaskBranchCommit(command, gitRoot, run.changeBranch, signal),
          readRemoteTaskBranchCommit(command, gitRoot, run.changeBranch, signal),
          resolveTaskRepository(command, gitRoot, signal),
        ]);
        if (branch !== run.implementationBranch) {
          throw new ImplementationRunVerificationError(
            `Текущей должна быть корневая ветка «${run.implementationBranch}»`,
          );
        }
        if (localRoot !== head || remoteRoot !== head) {
          throw new ImplementationRunVerificationError(
            `Корневая ветка «${run.changeBranch}» расходится с текущим HEAD`,
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
        const pr = await rootPullRequest.inspect(gitRoot, run.changeId, run.changeBranch, null, signal);
        if (pr.kind !== "open" || !pr.isDraft ||
            (run.publication.kind === "reviewed" && pr.identity.number !== run.publication.number)) {
          throw new ImplementationRunVerificationError("Корневой Draft PR изменился во время реализации");
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
