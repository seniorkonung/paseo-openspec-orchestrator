import { z } from "zod";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  changeBranchSchema,
  implementationBranchSchema,
} from "./change-branch.ts";
import {
  readImplementationPullRequestFeedback,
  type ImplementationFeedbackItem,
} from "./implementation-feedback-gateway.ts";
import {
  assertImplementationPullRequest,
  implementationPullRequestTitle,
} from "./implementation-publication.ts";
import {
  implementationRunSchema,
  type ImplementationRun,
} from "./implementation-run-model.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  assertCleanReviewWorktree,
  readCurrentReviewBranch,
  readLocalReviewBranchCommit,
  readOptionalRemoteReviewBranchCommit,
  readRemoteReviewBranchCommit,
  readReviewHeadCommit,
  readReviewPullRequest,
  resolveReviewRepository,
} from "./review-publication-gateway.ts";
import {
  ChangeReviewPublicationError,
  pullRequestNumberSchema,
  repositoryArgument,
} from "./review-publication-model.ts";

export const pendingImplementationMergeSessionSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    changeBranch: changeBranchSchema,
    implementationBranch: implementationBranchSchema,
    rootBaselineCommit: commitHashSchema,
    finalImplementationHead: commitHashSchema,
    pullRequestNumber: pullRequestNumberSchema,
  })
  .strict();

export type PendingImplementationMergeSession = z.infer<
  typeof pendingImplementationMergeSessionSchema
>;

export type ImplementationFeedbackInspection =
  | { readonly kind: "feedback"; readonly items: readonly ImplementationFeedbackItem[] }
  | { readonly kind: "clean" }
  | { readonly kind: "merged"; readonly session: PendingImplementationMergeSession };

export type ImplementationReadyGateInspection =
  | { readonly kind: "feedback"; readonly items: readonly ImplementationFeedbackItem[] }
  | { readonly kind: "open"; readonly url: string; readonly number: number }
  | { readonly kind: "merged"; readonly session: PendingImplementationMergeSession };

export interface ImplementationPullRequestService {
  inspectFeedback(
    workspaceDirectory: string,
    run: ImplementationRun,
    signal?: AbortSignal,
  ): Promise<ImplementationFeedbackInspection>;
  markReady(
    workspaceDirectory: string,
    run: ImplementationRun,
    signal?: AbortSignal,
  ): Promise<ImplementationFeedbackInspection>;
  inspectReadyGate(
    workspaceDirectory: string,
    run: ImplementationRun,
    signal?: AbortSignal,
  ): Promise<ImplementationReadyGateInspection>;
  completeMerge(
    workspaceDirectory: string,
    run: ImplementationRun,
    session: PendingImplementationMergeSession,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface ImplementationPullRequestServiceOptions {
  readonly command?: BoundedCommandRunner;
}

export class ImplementationPullRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImplementationPullRequestError";
  }
}

export function createImplementationPullRequestService(
  options: ImplementationPullRequestServiceOptions = {},
): ImplementationPullRequestService {
  const command = options.command ?? runBoundedCommand;

  const read = async (
    workspaceDirectory: string,
    run: ImplementationRun,
    signal?: AbortSignal,
  ) => {
    if (run.publication.kind === "unpublished") {
      throw new ImplementationPullRequestError("Implementation pull request ещё не создан");
    }
    return readReviewPullRequest(
      command,
      workspaceDirectory,
      repositoryArgument(run.repository),
      run.publication.number,
      signal,
    );
  };

  const unprocessed = async (
    workspaceDirectory: string,
    run: ImplementationRun,
    signal?: AbortSignal,
  ) => {
    if (run.publication.kind === "unpublished") {
      throw new ImplementationPullRequestError("Implementation pull request ещё не создан");
    }
    const items = await readImplementationPullRequestFeedback(
      command,
      workspaceDirectory,
      run.repository,
      run.publication.number,
      signal,
    );
    const processed = new Set(run.processedFeedbackFingerprints);
    return items.filter(({ fingerprint }) => !processed.has(fingerprint));
  };

  const makeDraft = async (
    workspaceDirectory: string,
    run: ImplementationRun,
    signal?: AbortSignal,
  ) => {
    if (run.publication.kind === "unpublished") {
      throw new ImplementationPullRequestError("Implementation pull request ещё не создан");
    }
    try {
      await command(
        "gh",
        [
          "pr",
          "ready",
          String(run.publication.number),
          "--repo",
          repositoryArgument(run.repository),
          "--undo",
        ],
        { cwd: workspaceDirectory, signal },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ImplementationPullRequestError(
        "Не удалось вернуть implementation pull request в Draft",
      );
    }
    const pullRequest = await read(workspaceDirectory, run, signal);
    assertPullRequestShape(pullRequest, run, currentHead(run), true);
  };

  const inspectFeedback = async (
    workspaceDirectory: string,
    runInput: ImplementationRun,
    signal?: AbortSignal,
  ): Promise<ImplementationFeedbackInspection> => {
    const run = implementationRunSchema.parse(runInput);
    const pullRequest = await read(workspaceDirectory, run, signal);
    if (pullRequest.state === "MERGED") {
      assertMergedPullRequest(pullRequest, run);
      await assertLocalState(
        command,
        workspaceDirectory,
        run,
        currentHead(run),
        signal,
        true,
      );
      return { kind: "merged", session: mergeSession(run) };
    }
    await assertLocalState(
      command,
      workspaceDirectory,
      run,
      run.rootBaselineCommit,
      signal,
    );
    if (pullRequest.state !== "OPEN") {
      throw new ImplementationPullRequestError(
        "Implementation pull request закрыт без merge",
      );
    }
    assertPullRequestShape(pullRequest, run, currentHead(run), pullRequest.isDraft);
    const items = await unprocessed(workspaceDirectory, run, signal);
    if (items.length === 0) return { kind: "clean" };
    if (!pullRequest.isDraft) await makeDraft(workspaceDirectory, run, signal);
    return { kind: "feedback", items };
  };

  return {
    inspectFeedback,

    async markReady(workspaceDirectory, runInput, signal) {
      const run = implementationRunSchema.parse(runInput);
      if (run.batch.kind !== "empty") {
        throw new ImplementationPullRequestError(
          "Implementation PR нельзя сделать Ready с непустым task-пакетом",
        );
      }
      const before = await inspectFeedback(workspaceDirectory, run, signal);
      if (before.kind !== "clean") return before;
      if (run.publication.kind === "unpublished") {
        throw new ImplementationPullRequestError("Implementation pull request ещё не создан");
      }
      const beforeReady = await read(workspaceDirectory, run, signal);
      if (beforeReady.state === "MERGED") {
        assertMergedPullRequest(beforeReady, run);
        return { kind: "merged", session: mergeSession(run) };
      }
      if (beforeReady.state !== "OPEN") {
        throw new ImplementationPullRequestError(
          "Implementation pull request закрыт без merge",
        );
      }
      assertPullRequestShape(beforeReady, run, currentHead(run), beforeReady.isDraft);
      if (beforeReady.isDraft) {
        try {
          await command(
            "gh",
            [
              "pr",
              "ready",
              String(run.publication.number),
              "--repo",
              repositoryArgument(run.repository),
            ],
            { cwd: workspaceDirectory, signal },
          );
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new ImplementationPullRequestError(
            "Не удалось перевести implementation pull request в Ready",
          );
        }
      }
      const pullRequest = await read(workspaceDirectory, run, signal);
      if (pullRequest.state === "MERGED") {
        assertMergedPullRequest(pullRequest, run);
        return { kind: "merged", session: mergeSession(run) };
      }
      if (pullRequest.state !== "OPEN") {
        throw new ImplementationPullRequestError(
          "Implementation pull request закрыт без merge",
        );
      }
      assertPullRequestShape(pullRequest, run, currentHead(run), false);
      if (pullRequest.isDraft) {
        throw new ImplementationPullRequestError(
          "Implementation pull request остался Draft после gh pr ready",
        );
      }
      const raced = await unprocessed(workspaceDirectory, run, signal);
      if (raced.length > 0) {
        await makeDraft(workspaceDirectory, run, signal);
        return { kind: "feedback", items: raced };
      }
      return { kind: "clean" };
    },

    async inspectReadyGate(workspaceDirectory, runInput, signal) {
      const run = implementationRunSchema.parse(runInput);
      const pullRequest = await read(workspaceDirectory, run, signal);
      if (pullRequest.state === "MERGED") {
        assertMergedPullRequest(pullRequest, run);
        await assertLocalState(
          command,
          workspaceDirectory,
          run,
          currentHead(run),
          signal,
          true,
        );
        return { kind: "merged", session: mergeSession(run) };
      }
      await assertLocalState(
        command,
        workspaceDirectory,
        run,
        run.rootBaselineCommit,
        signal,
      );
      if (pullRequest.state !== "OPEN") {
        throw new ImplementationPullRequestError(
          "Implementation pull request закрыт без merge",
        );
      }
      assertPullRequestShape(pullRequest, run, currentHead(run), false);
      if (pullRequest.isDraft) {
        throw new ImplementationPullRequestError(
          "Ready gate получил Draft implementation pull request",
        );
      }
      const items = await unprocessed(workspaceDirectory, run, signal);
      if (items.length > 0) {
        await makeDraft(workspaceDirectory, run, signal);
        return { kind: "feedback", items };
      }
      return { kind: "open", url: pullRequest.url, number: pullRequest.number };
    },

    async completeMerge(workspaceDirectory, runInput, sessionInput, signal) {
      const run = implementationRunSchema.parse(runInput);
      const session = pendingImplementationMergeSessionSchema.parse(sessionInput);
      if (
        session.changeId !== run.changeId ||
        session.changeBranch !== run.changeBranch ||
        session.implementationBranch !== run.implementationBranch ||
        session.rootBaselineCommit !== run.rootBaselineCommit ||
        session.finalImplementationHead !== currentHead(run) ||
        run.publication.kind === "unpublished" ||
        session.pullRequestNumber !== run.publication.number
      ) {
        throw new ImplementationPullRequestError(
          "Merge-сессия не соответствует implementation-run",
        );
      }
      await assertCleanReviewWorktree(command, workspaceDirectory, signal);
      await assertRepositoryIdentity(command, workspaceDirectory, run, signal);
      const pullRequest = await read(workspaceDirectory, run, signal);
      if (
        pullRequest.state !== "MERGED" ||
        pullRequest.number !== session.pullRequestNumber ||
        pullRequest.baseRefName !== session.changeBranch ||
        pullRequest.headRefName !== session.implementationBranch ||
        pullRequest.headRefOid !== session.finalImplementationHead ||
        pullRequest.title !== implementationPullRequestTitle(session.changeId)
      ) {
        throw new ImplementationPullRequestError(
          "Implementation pull request больше не соответствует pending merge",
        );
      }
      const [branch, head, localRoot, remoteImplementation] = await Promise.all([
        readCurrentReviewBranch(command, workspaceDirectory, signal),
        readReviewHeadCommit(command, workspaceDirectory, signal),
        readLocalReviewBranchCommit(command, workspaceDirectory, session.changeBranch, signal),
        readOptionalRemoteReviewBranchCommit(
          command,
          workspaceDirectory,
          session.implementationBranch,
          signal,
        ),
      ]);
      const beforeMerge =
        branch === session.implementationBranch &&
        head === session.finalImplementationHead &&
        localRoot === session.rootBaselineCommit;
      const recoveringRoot =
        branch === session.changeBranch &&
        head === localRoot &&
        (head === session.rootBaselineCommit || head === session.finalImplementationHead);
      if (
        (remoteImplementation !== null &&
          remoteImplementation !== session.finalImplementationHead) ||
        (!beforeMerge && !recoveringRoot)
      ) {
        throw new ImplementationPullRequestError(
          "Локальные Git refs изменились перед завершением implementation merge",
        );
      }
      try {
        await command("git", ["fetch", "origin", session.changeBranch], {
          cwd: workspaceDirectory,
          signal,
        });
        const fetchedHead = commitHashSchema.parse((
          await command("git", ["rev-parse", "FETCH_HEAD"], {
            cwd: workspaceDirectory,
            signal,
          })
        ).stdout.trim());
        if (fetchedHead !== session.finalImplementationHead) {
          throw new ImplementationPullRequestError(
            "Origin root-ветка не совпадает с финальным implementation head",
          );
        }
        if (branch !== session.changeBranch) {
          await command("git", ["switch", session.changeBranch], {
            cwd: workspaceDirectory,
            signal,
          });
        }
        await command("git", ["merge", "--ff-only", "FETCH_HEAD"], {
          cwd: workspaceDirectory,
          signal,
        });
      } catch (error) {
        if (error instanceof ImplementationPullRequestError || signal?.aborted) throw error;
        throw new ImplementationPullRequestError(
          `Не удалось fast-forward обновить «${session.changeBranch}» после merge PR`,
        );
      }
      const [completedBranch, completedHead] = await Promise.all([
        readCurrentReviewBranch(command, workspaceDirectory, signal),
        readReviewHeadCommit(command, workspaceDirectory, signal),
      ]);
      if (
        completedBranch !== session.changeBranch ||
        completedHead !== session.finalImplementationHead
      ) {
        throw new ImplementationPullRequestError(
          "Корневая ветка не совпадает с финальным implementation head",
        );
      }
      return completedHead;
    },
  };
}

function currentHead(run: ImplementationRun): string {
  return run.batch.kind === "empty" ? run.batch.baseCommit : run.batch.kind === "reviewed"
    ? run.batch.reviewCommit
    : run.batch.headCommit;
}

function mergeSession(run: ImplementationRun): PendingImplementationMergeSession {
  if (run.publication.kind === "unpublished") {
    throw new ImplementationPullRequestError("Implementation pull request ещё не создан");
  }
  return pendingImplementationMergeSessionSchema.parse({
    changeId: run.changeId,
    changeBranch: run.changeBranch,
    implementationBranch: run.implementationBranch,
    rootBaselineCommit: run.rootBaselineCommit,
    finalImplementationHead: currentHead(run),
    pullRequestNumber: run.publication.number,
  });
}

function assertPullRequestShape(
  pullRequest: Awaited<ReturnType<typeof readReviewPullRequest>>,
  run: ImplementationRun,
  head: string,
  draft: boolean,
): void {
  try {
    assertImplementationPullRequest(pullRequest, run, head, draft);
  } catch (error) {
    if (error instanceof ChangeReviewPublicationError) {
      throw new ImplementationPullRequestError(error.message);
    }
    throw error;
  }
}

function assertMergedPullRequest(
  pullRequest: Awaited<ReturnType<typeof readReviewPullRequest>>,
  run: ImplementationRun,
): void {
  if (
    run.publication.kind === "unpublished" ||
    pullRequest.state !== "MERGED" ||
    pullRequest.number !== run.publication.number ||
    pullRequest.isCrossRepository ||
    pullRequest.baseRefName !== run.changeBranch ||
    pullRequest.headRefName !== run.implementationBranch ||
    pullRequest.headRefOid !== currentHead(run) ||
    pullRequest.title !== implementationPullRequestTitle(run.changeId)
  ) {
    throw new ImplementationPullRequestError(
      "Merged implementation pull request не соответствует implementation-run",
    );
  }
}

async function assertLocalState(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  run: ImplementationRun,
  expectedRemoteRoot: string,
  signal?: AbortSignal,
  allowMissingRemoteImplementation = false,
): Promise<void> {
  await assertCleanReviewWorktree(command, workspaceDirectory, signal);
  const [branch, head, localRoot, remoteRoot, repository] = await Promise.all([
    readCurrentReviewBranch(command, workspaceDirectory, signal),
    readReviewHeadCommit(command, workspaceDirectory, signal),
    readLocalReviewBranchCommit(command, workspaceDirectory, run.changeBranch, signal),
    readRemoteReviewBranchCommit(
      command,
      workspaceDirectory,
      run.changeBranch,
      signal,
    ),
    resolveReviewRepository(command, workspaceDirectory, signal),
  ]);
  if (
    branch !== run.implementationBranch ||
    head !== currentHead(run) ||
    localRoot !== run.rootBaselineCommit ||
    remoteRoot !== expectedRemoteRoot
  ) {
    throw new ImplementationPullRequestError(
      "Локальное состояние implementation-run изменилось",
    );
  }
  const remoteImplementation = await readOptionalRemoteReviewBranchCommit(
    command,
    workspaceDirectory,
    run.implementationBranch,
    signal,
  );
  if (
    remoteImplementation !== head &&
    !(allowMissingRemoteImplementation && remoteImplementation === null)
  ) {
    throw new ImplementationPullRequestError(
      "Origin implementation-ветки не совпадает с локальным HEAD",
    );
  }
  assertResolvedRepository(run, repository);
}

async function assertRepositoryIdentity(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  run: ImplementationRun,
  signal?: AbortSignal,
): Promise<void> {
  const repository = await resolveReviewRepository(
    command,
    workspaceDirectory,
    signal,
  );
  assertResolvedRepository(run, repository);
}

function assertResolvedRepository(
  run: ImplementationRun,
  repository: { readonly host: string; readonly nameWithOwner: string; readonly url: string },
): void {
  if (
    repository.host !== run.repository.host ||
    repository.nameWithOwner.toLowerCase() !== run.repository.nameWithOwner.toLowerCase() ||
    repository.url !== run.repository.url
  ) {
    throw new ImplementationPullRequestError(
      "GitHub repository identity изменилась во время implementation-run",
    );
  }
}
