import { z } from "zod";
import {
  changeBranchFor,
  changeBranchSchema,
  planningBranchFor,
  planningBranchSchema,
} from "./change-branch.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-command.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  assertCleanReviewWorktree,
  listReviewPullRequests,
  readCurrentReviewBranch,
  readLocalReviewBranchCommit,
  readOptionalRemoteReviewBranchCommit,
  readRemoteReviewBranchCommit,
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
  type ResolvedReviewRepository,
  type ReviewPullRequest,
} from "./review-publication-model.ts";

export const pendingPlanningMergeSessionSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    changeBranch: changeBranchSchema,
    planningBranch: planningBranchSchema,
    planningPullRequestNumber: pullRequestNumberSchema,
    mergedPlanningHead: commitHashSchema,
    repositoryHost: githubHostSchema,
    repositoryNameWithOwner: repositoryNameWithOwnerSchema,
    repositoryUrl: httpsUrlSchema,
  })
  .strict()
  .superRefine((session, context) => {
    if (session.changeBranch !== changeBranchFor(session.changeId)) {
      context.addIssue({
        code: "custom",
        path: ["changeBranch"],
        message: "Корневая ветка не соответствует change",
      });
    }
    if (session.planningBranch !== planningBranchFor(session.changeId)) {
      context.addIssue({
        code: "custom",
        path: ["planningBranch"],
        message: "Planning-ветка не соответствует change",
      });
    }
  });

export type PendingPlanningMergeSession = z.infer<
  typeof pendingPlanningMergeSessionSchema
>;

export type PlanningMergeInspection =
  | {
      readonly kind: "open";
      readonly pullRequest: { readonly number: number; readonly url: string };
    }
  | {
      readonly kind: "merged";
      readonly session: PendingPlanningMergeSession;
    };

export interface PlanningMergeService {
  inspect(
    workspaceDirectory: string,
    changeId: string,
    changeBranch: string,
    planningBranch: string,
    signal?: AbortSignal,
  ): Promise<PlanningMergeInspection>;
  complete(
    workspaceDirectory: string,
    session: PendingPlanningMergeSession,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface PlanningMergeServiceOptions {
  readonly command?: BoundedCommandRunner;
}

export class PlanningMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningMergeError";
  }
}

export function createPlanningMergeService(
  options: PlanningMergeServiceOptions = {},
): PlanningMergeService {
  const command = options.command ?? runBoundedCommand;

  return {
    async inspect(
      workspaceDirectory,
      changeIdInput,
      changeBranchInput,
      planningBranchInput,
      signal,
    ) {
      const changeId = openSpecChangeIdSchema.parse(changeIdInput);
      const changeBranch = changeBranchSchema.parse(changeBranchInput);
      const planningBranch = planningBranchSchema.parse(planningBranchInput);
      assertBranchPair(changeId, changeBranch, planningBranch);
      await assertCleanReviewWorktree(command, workspaceDirectory, signal);

      const currentBranch = await readCurrentReviewBranch(
        command,
        workspaceDirectory,
        signal,
      );
      if (currentBranch !== planningBranch) {
        throw new PlanningMergeError(
          `До merge planning PR должна быть активна ветка «${planningBranch}»`,
        );
      }
      const [localPlanningHead, repository] = await Promise.all([
        readReviewHeadCommit(command, workspaceDirectory, signal),
        resolveReviewRepository(command, workspaceDirectory, signal),
      ]);
      const pullRequest = await readOnlyPlanningPullRequest(
        command,
        workspaceDirectory,
        repository,
        planningBranch,
        signal,
      );
      assertPlanningPullRequest(
        pullRequest,
        repository.url,
        changeBranch,
        planningBranch,
      );
      if (pullRequest.headRefOid !== localPlanningHead) {
        throw new PlanningMergeError(
          "Локальная planning-ветка не соответствует head pull request",
        );
      }

      const remotePlanningHead = await readOptionalRemoteReviewBranchCommit(
        command,
        workspaceDirectory,
        planningBranch,
        signal,
      );
      if (pullRequest.state === "OPEN") {
        if (remotePlanningHead !== localPlanningHead) {
          throw new PlanningMergeError(
            `Git remote origin не содержит текущий HEAD planning-ветки «${planningBranch}»`,
          );
        }
        return {
          kind: "open",
          pullRequest: { number: pullRequest.number, url: pullRequest.url },
        };
      }
      if (pullRequest.state === "CLOSED") {
        throw new PlanningMergeError(
          `Planning pull request #${pullRequest.number} закрыт без merge`,
        );
      }
      if (
        remotePlanningHead !== null &&
        remotePlanningHead !== localPlanningHead
      ) {
        throw new PlanningMergeError(
          "Удалённая planning-ветка изменилась после merge pull request",
        );
      }
      return {
        kind: "merged",
        session: pendingPlanningMergeSessionSchema.parse({
          changeId,
          changeBranch,
          planningBranch,
          planningPullRequestNumber: pullRequest.number,
          mergedPlanningHead: localPlanningHead,
          repositoryHost: repository.host,
          repositoryNameWithOwner: repository.nameWithOwner,
          repositoryUrl: repository.url,
        }),
      };
    },

    async complete(workspaceDirectory, sessionInput, signal) {
      const session = pendingPlanningMergeSessionSchema.parse(sessionInput);
      await assertCleanReviewWorktree(command, workspaceDirectory, signal);
      await assertMergedPullRequest(
        command,
        workspaceDirectory,
        session,
        signal,
      );
      const localPlanningHead = await readLocalReviewBranchCommit(
        command,
        workspaceDirectory,
        session.planningBranch,
        signal,
      );
      if (localPlanningHead !== session.mergedPlanningHead) {
        throw new PlanningMergeError(
          "Локальная planning-ветка изменилась после подтверждения merge",
        );
      }

      const currentBranch = await readCurrentReviewBranch(
        command,
        workspaceDirectory,
        signal,
      );
      if (
        currentBranch !== session.planningBranch &&
        currentBranch !== session.changeBranch
      ) {
        throw new PlanningMergeError(
          `Для восстановления требуется ветка «${session.planningBranch}» или «${session.changeBranch}»`,
        );
      }
      await fetchRootBranch(
        command,
        workspaceDirectory,
        session.changeBranch,
        signal,
      );
      const fetchedHead = await readFetchedHead(command, workspaceDirectory, signal);
      const remoteHead = await readRemoteReviewBranchCommit(
        command,
        workspaceDirectory,
        session.changeBranch,
        signal,
      );
      if (fetchedHead !== remoteHead) {
        throw new PlanningMergeError(
          `FETCH_HEAD не соответствует origin/${session.changeBranch}`,
        );
      }

      if (currentBranch === session.planningBranch) {
        await runGitEffect(
          command,
          workspaceDirectory,
          ["switch", session.changeBranch],
          `Не удалось переключиться на корневую ветку «${session.changeBranch}»`,
          signal,
        );
      }
      await runGitEffect(
        command,
        workspaceDirectory,
        ["merge", "--ff-only", fetchedHead],
        `Корневую ветку «${session.changeBranch}» невозможно обновить fast-forward`,
        signal,
      );

      const [completedBranch, completedHead] = await Promise.all([
        readCurrentReviewBranch(command, workspaceDirectory, signal),
        readReviewHeadCommit(command, workspaceDirectory, signal),
      ]);
      if (
        completedBranch !== session.changeBranch ||
        completedHead !== remoteHead
      ) {
        throw new PlanningMergeError(
          "Корневая ветка не совпадает с origin после fast-forward",
        );
      }
      await assertCleanReviewWorktree(command, workspaceDirectory, signal);
      return session.changeBranch;
    },
  };
}

function assertBranchPair(
  changeId: string,
  changeBranch: string,
  planningBranch: string,
): void {
  if (
    changeBranch !== changeBranchFor(changeId) ||
    planningBranch !== planningBranchFor(changeId)
  ) {
    throw new PlanningMergeError(
      "Git-ветки merge-gate не соответствуют OpenSpec change",
    );
  }
}

async function readOnlyPlanningPullRequest(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repository: ResolvedReviewRepository,
  planningBranch: string,
  signal?: AbortSignal,
): Promise<ReviewPullRequest> {
  const pullRequests = await listReviewPullRequests(
    command,
    workspaceDirectory,
    repositoryArgument(repository),
    planningBranch,
    "all",
    signal,
  );
  if (pullRequests.length !== 1) {
    throw new PlanningMergeError(
      `Для planning-ветки «${planningBranch}» должен существовать ровно один pull request`,
    );
  }
  return readReviewPullRequest(
    command,
    workspaceDirectory,
    repositoryArgument(repository),
    pullRequests[0]!.number,
    signal,
  );
}

function assertPlanningPullRequest(
  pullRequest: ReviewPullRequest,
  repositoryUrl: string,
  changeBranch: string,
  planningBranch: string,
): void {
  assertPullRequestRepository(pullRequest, repositoryUrl);
  if (
    pullRequest.isCrossRepository ||
    pullRequest.isDraft ||
    pullRequest.baseRefName !== changeBranch ||
    pullRequest.headRefName !== planningBranch
  ) {
    throw new PlanningMergeError(
      "Planning pull request имеет неверные repository, base/head refs или Draft-состояние",
    );
  }
}

async function assertMergedPullRequest(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  session: PendingPlanningMergeSession,
  signal?: AbortSignal,
): Promise<void> {
  const repository = await resolveReviewRepository(
    command,
    workspaceDirectory,
    signal,
  );
  if (
    repository.host !== session.repositoryHost ||
    repository.nameWithOwner.toLowerCase() !==
      session.repositoryNameWithOwner.toLowerCase() ||
    repository.url !== session.repositoryUrl
  ) {
    throw new PlanningMergeError(
      "Git remote origin больше не соответствует сохранённому GitHub-репозиторию",
    );
  }
  const pullRequest = await readReviewPullRequest(
    command,
    workspaceDirectory,
    repositoryArgument(repository),
    session.planningPullRequestNumber,
    signal,
  );
  const allPullRequests = await listReviewPullRequests(
    command,
    workspaceDirectory,
    repositoryArgument(repository),
    session.planningBranch,
    "all",
    signal,
  );
  if (
    allPullRequests.length !== 1 ||
    allPullRequests[0]!.number !== session.planningPullRequestNumber
  ) {
    throw new PlanningMergeError(
      "Набор pull request planning-ветки изменился после подтверждённого merge",
    );
  }
  assertPlanningPullRequest(
    pullRequest,
    repository.url,
    session.changeBranch,
    session.planningBranch,
  );
  if (
    pullRequest.state !== "MERGED" ||
    pullRequest.headRefOid !== session.mergedPlanningHead
  ) {
    throw new PlanningMergeError(
      "Planning pull request больше не соответствует подтверждённому merge",
    );
  }
}

async function fetchRootBranch(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  changeBranch: string,
  signal?: AbortSignal,
): Promise<void> {
  await runGitEffect(
    command,
    workspaceDirectory,
    ["fetch", "--no-tags", "origin", `refs/heads/${changeBranch}`],
    `Не удалось получить origin/${changeBranch}`,
    signal,
  );
}

async function readFetchedHead(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["rev-parse", "FETCH_HEAD"], {
      cwd: workspaceDirectory,
      signal,
    });
    return commitHashSchema.parse(result.stdout.trim());
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new PlanningMergeError("Не удалось проверить FETCH_HEAD корневой ветки");
  }
}

async function runGitEffect(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  args: readonly string[],
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await command("git", args, { cwd: workspaceDirectory, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new PlanningMergeError(message);
  }
}
