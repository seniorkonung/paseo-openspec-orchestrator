import { z } from "zod";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  parseGitHubRemoteIdentity,
  type GitHubRemoteIdentity,
} from "./github-repository-identity.ts";
import {
  ChangeReviewPublicationError,
  REVIEW_REMOTE,
  parseReviewBranch,
  repositoryArgument,
  reviewBranchSchema,
  reviewPullRequestSchema,
  reviewRepositorySchema,
  type ResolvedReviewRepository,
  type ReviewPullRequest,
} from "./review-publication-model.ts";
import { updateGitHubPullRequest } from "./github-pull-request-mutation.ts";

const MAX_PULL_REQUESTS = 100;
const pullRequestListSchema = z.array(reviewPullRequestSchema).max(MAX_PULL_REQUESTS);

export async function resolveReviewRepository(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<ResolvedReviewRepository> {
  let originUrl: string;
  try {
    const result = await command("git", ["remote", "get-url", REVIEW_REMOTE], {
      cwd: workspaceDirectory,
      signal,
    });
    originUrl = result.stdout.trim();
    if (!originUrl) throw new Error("Пустой URL origin");
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      "Git remote origin отсутствует или недоступен",
    );
  }

  const remote = parseGitHubRemote(originUrl);
  try {
    await command("gh", ["auth", "status", "--hostname", remote.host], {
      cwd: workspaceDirectory,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `GitHub CLI недоступен или не авторизован для origin host «${remote.host}»`,
    );
  }

  const argument = repositoryArgument(remote);
  let repository: z.output<typeof reviewRepositorySchema>;
  try {
    const result = await command(
      "gh",
      ["repo", "view", argument, "--json", "nameWithOwner,url"],
      { cwd: workspaceDirectory, signal },
    );
    repository = reviewRepositorySchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      "Git remote origin не разрешается в доступный GitHub-репозиторий",
    );
  }
  if (
    new URL(repository.url).hostname.toLowerCase() !== remote.host ||
    repository.nameWithOwner.toLowerCase() !== remote.nameWithOwner.toLowerCase()
  ) {
    throw new ChangeReviewPublicationError(
      "GitHub CLI разрешил другой репозиторий вместо Git remote origin",
    );
  }
  return { ...remote, url: repository.url };
}

export async function listReviewPullRequests(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repository: string,
  branch: string,
  state: "open" | "all",
  signal?: AbortSignal,
): Promise<readonly ReviewPullRequest[]> {
  try {
    const result = await command(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--head",
        branch,
        "--state",
        state,
        "--limit",
        String(MAX_PULL_REQUESTS),
        "--json",
        "number,url,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,mergeCommit,title,body",
      ],
      { cwd: workspaceDirectory, signal },
    );
    return pullRequestListSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    if (error instanceof ChangeReviewPublicationError || signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `Не удалось получить pull request ветки «${branch}»`,
    );
  }
}

export async function readReviewPullRequest(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repository: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReviewPullRequest> {
  try {
    const result = await command(
      "gh",
      [
        "pr",
        "view",
        String(number),
        "--repo",
        repository,
        "--json",
        "number,url,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,mergeCommit,title,body",
      ],
      { cwd: workspaceDirectory, signal },
    );
    return reviewPullRequestSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `Не удалось прочитать pull request #${number}`,
    );
  }
}

export async function updateReviewPullRequestBody(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  repository: ResolvedReviewRepository,
  pullRequestNumber: number,
  body: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await updateGitHubPullRequest(
      command,
      workspaceDirectory,
      repository,
      pullRequestNumber,
      { body },
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `Не удалось обновить описание review pull request #${pullRequestNumber}`,
    );
  }
}

export async function assertCleanReviewWorktree(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await command(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: workspaceDirectory, signal },
    );
    if (result.stdout.length > 0) {
      throw new ChangeReviewPublicationError(
        "Рабочее дерево Git содержит незакоммиченные или неотслеживаемые изменения",
      );
    }
  } catch (error) {
    if (error instanceof ChangeReviewPublicationError || signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      "Не удалось проверить чистоту рабочего дерева Git",
    );
  }
}

export async function readCurrentReviewBranch(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["branch", "--show-current"], {
      cwd: workspaceDirectory,
      signal,
    });
    return reviewBranchSchema.parse(result.stdout);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError("Не удалось подтвердить текущую Git-ветку");
  }
}

export async function readReviewHeadCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["rev-parse", "HEAD"], {
      cwd: workspaceDirectory,
      signal,
    });
    return commitHashSchema.parse(result.stdout.trim());
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError("Не удалось определить текущий Git HEAD");
  }
}

export async function readLocalReviewBranchCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const ref = `refs/heads/${parseReviewBranch(branch)}`;
  try {
    const result = await command(
      "git",
      ["for-each-ref", "--format=%(objectname)%00%(refname)", ref],
      { cwd: workspaceDirectory, signal },
    );
    if (result.stdout.length === 0) return null;
    const [hash, reportedRef, extra] = result.stdout.trimEnd().split("\0");
    if (extra !== undefined || reportedRef !== ref) {
      throw new Error("Некорректный local ref");
    }
    return commitHashSchema.parse(hash);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `Не удалось прочитать локальную ветку «${branch}»`,
    );
  }
}

export async function readRemoteReviewBranchCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string> {
  const commit = await readOptionalRemoteReviewBranchCommit(
    command,
    workspaceDirectory,
    branch,
    signal,
  );
  if (commit === null) {
    throw new ChangeReviewPublicationError(
      `Ветка «${branch}» отсутствует в Git remote origin`,
    );
  }
  return commit;
}

export async function readOptionalRemoteReviewBranchCommit(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const parsedBranch = parseReviewBranch(branch);
  const ref = `refs/heads/${parsedBranch}`;
  try {
    const result = await command(
      "git",
      ["ls-remote", "--heads", REVIEW_REMOTE, ref],
      { cwd: workspaceDirectory, signal },
    );
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    if (lines.length !== 1) throw new Error("Неоднозначный remote ref");
    const [hash, reportedRef, extra] = lines[0]!.split("\t");
    if (extra !== undefined || reportedRef !== ref) {
      throw new Error("Некорректный remote ref");
    }
    return commitHashSchema.parse(hash);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(
      `Не удалось прочитать ветку «${parsedBranch}» в Git remote origin`,
    );
  }
}

export async function assertReviewCommitDescendsFrom(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  ancestor: string,
  descendant: string,
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await command("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: workspaceDirectory,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewPublicationError(message);
  }
}

function parseGitHubRemote(remoteUrl: string): GitHubRemoteIdentity {
  const parsed = parseGitHubRemoteIdentity(remoteUrl);
  if (parsed.kind === "valid") return parsed.identity;
  if (parsed.reason === "host") {
    throw new ChangeReviewPublicationError(
      "Git remote origin содержит недопустимый host",
    );
  }
  if (parsed.reason === "repository") {
    throw new ChangeReviewPublicationError(
      "Git remote origin должен указывать на GitHub-репозиторий owner/name",
    );
  }
  throw new ChangeReviewPublicationError(
    "Git remote origin должен указывать на GitHub",
  );
}
