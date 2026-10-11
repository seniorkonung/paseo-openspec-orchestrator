import { z } from "zod";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
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
  REVIEW_PARENT_BRANCH,
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

/** Сколько проверок CI сообщено для HEAD-коммита PR и сколько из них не завершено. */
export interface RootPullRequestCheckProgress {
  readonly total: number;
  readonly pending: number;
}

export type RootPullRequestCheckInspection =
  | {
      readonly kind: "open";
      readonly isDraft: boolean;
      readonly head: string;
      readonly checks: RootPullRequestCheckProgress;
    }
  | { readonly kind: "merged"; readonly head: string }
  | { readonly kind: "closed"; readonly head: string };

const checkRunStateSchema = z.enum([
  "ACTION_REQUIRED",
  "CANCELLED",
  "COMPLETED",
  "FAILURE",
  "IN_PROGRESS",
  "NEUTRAL",
  "PENDING",
  "QUEUED",
  "SKIPPED",
  "STALE",
  "STARTUP_FAILURE",
  "SUCCESS",
  "TIMED_OUT",
  "WAITING",
]);
const statusContextStateSchema = z.enum(["EXPECTED", "ERROR", "FAILURE", "PENDING", "SUCCESS"]);

// Оркестратор не оценивает исход проверок: важно только, завершена ли каждая.
const CHECK_RUN_STATE_PENDING: Readonly<Record<z.infer<typeof checkRunStateSchema>, boolean>> = {
  ACTION_REQUIRED: false,
  CANCELLED: false,
  COMPLETED: false,
  FAILURE: false,
  IN_PROGRESS: true,
  NEUTRAL: false,
  PENDING: true,
  QUEUED: true,
  SKIPPED: false,
  STALE: false,
  STARTUP_FAILURE: false,
  SUCCESS: false,
  TIMED_OUT: false,
  WAITING: true,
};
const STATUS_CONTEXT_STATE_PENDING: Readonly<Record<z.infer<typeof statusContextStateSchema>, boolean>> = {
  EXPECTED: true,
  ERROR: false,
  FAILURE: false,
  PENDING: true,
  SUCCESS: false,
};

const stateCountSchema = <State extends z.ZodType>(state: State) =>
  z.array(z.object({ state, count: z.number().int().nonnegative().max(1_000_000) })).max(64);

// Счётчики по состояниям агрегируют все проверки коммита, поэтому пагинация не нужна.
const ROOT_CHECKS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      state
      isDraft
      isCrossRepository
      baseRefName
      headRefName
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts {
                checkRunCountsByState { state count }
                statusContextCountsByState { state count }
              }
            }
          }
        }
      }
    }
  }
}`;

const rootChecksResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        number: pullRequestNumberSchema,
        state: z.enum(["OPEN", "CLOSED", "MERGED"]),
        isDraft: z.boolean(),
        isCrossRepository: z.boolean(),
        baseRefName: z.string(),
        headRefName: z.string(),
        headRefOid: commitHashSchema,
        commits: z.object({
          nodes: z.tuple([
            z.object({
              commit: z.object({
                oid: commitHashSchema,
                statusCheckRollup: z.object({
                  contexts: z.object({
                    checkRunCountsByState: stateCountSchema(checkRunStateSchema),
                    statusContextCountsByState: stateCountSchema(statusContextStateSchema),
                  }),
                }).nullable(),
              }),
            }),
          ]),
        }),
      }),
    }),
  }),
});

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
  /**
   * Читает только GitHub: состояние известного корневого PR и незавершённые
   * проверки его HEAD-коммита. Локальный репозиторий не проверяется, поэтому
   * результат нужно сверить с проверенным HEAD.
   */
  inspectChecks(
    workspaceDirectory: string,
    identity: RootPullRequestIdentity,
    signal?: AbortSignal,
  ): Promise<RootPullRequestCheckInspection>;
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

  const inspectChecks: RootPullRequestService["inspectChecks"] = async (
    workspaceDirectory,
    identityInput,
    signal,
  ) => {
    const identity = rootPullRequestIdentitySchema.parse(identityInput);
    const [owner, name] = identity.repositoryNameWithOwner.split("/");
    let response: z.infer<typeof rootChecksResponseSchema>;
    try {
      const result = await command(
        "gh",
        [
          "api",
          "graphql",
          "--hostname",
          identity.repositoryHost,
          "-f",
          `query=${ROOT_CHECKS_QUERY}`,
          "-f",
          `owner=${owner!}`,
          "-f",
          `name=${name!}`,
          "-F",
          `number=${identity.number}`,
        ],
        { cwd: workspaceDirectory, signal },
      );
      response = rootChecksResponseSchema.parse(JSON.parse(result.stdout));
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RootPullRequestError(
        `Не удалось прочитать проверки CI корневого pull request #${identity.number}`,
      );
    }
    const pullRequest = response.data.repository.pullRequest;
    const [{ commit }] = pullRequest.commits.nodes;
    if (
      pullRequest.number !== identity.number ||
      pullRequest.isCrossRepository ||
      pullRequest.baseRefName !== REVIEW_PARENT_BRANCH ||
      pullRequest.headRefName !== identity.changeBranch
    ) {
      throw new RootPullRequestError("Корневой pull request имеет неверные repository, base или head");
    }
    const head = pullRequest.headRefOid;
    if (pullRequest.state === "MERGED") return { kind: "merged", head };
    if (pullRequest.state === "CLOSED") return { kind: "closed", head };
    // Сразу после push GitHub может отдать проверки предыдущего коммита.
    if (commit.oid !== head) {
      throw new RootPullRequestError("GitHub ещё не обновил проверки HEAD корневого pull request");
    }
    const contexts = commit.statusCheckRollup?.contexts;
    const counts = [
      ...(contexts?.checkRunCountsByState ?? []).map(({ state, count }) => ({ count, pending: CHECK_RUN_STATE_PENDING[state] })),
      ...(contexts?.statusContextCountsByState ?? []).map(({ state, count }) => ({ count, pending: STATUS_CONTEXT_STATE_PENDING[state] })),
    ];
    return {
      kind: "open",
      isDraft: pullRequest.isDraft,
      head,
      checks: {
        total: counts.reduce((sum, { count }) => sum + count, 0),
        pending: counts.reduce((sum, { count, pending }) => sum + (pending ? count : 0), 0),
      },
    };
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
    inspectChecks,
  };
}
