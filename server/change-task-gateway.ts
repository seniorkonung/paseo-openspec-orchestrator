import { z } from "zod";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  ChangeTaskExecutionError,
  TASK_REMOTE,
  parseTaskBranch,
  taskRepositoryArgument,
  taskRepositorySchema,
  type ResolvedTaskRepository,
  type TaskGitHubRemoteIdentity,
} from "./change-task-model.ts";
import {
  parseGitHubRemoteIdentity,
} from "./github-repository-identity.ts";

export async function readTaskGitRoot(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspaceDirectory,
      signal,
    });
    const root = result.stdout.trim();
    if (!root) throw new Error("Пустой Git root");
    return root;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeTaskExecutionError("Не удалось определить корень Git-репозитория");
  }
}

export async function assertCleanTaskWorktree(
  command: BoundedCommandRunner,
  gitRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await command(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: gitRoot, signal },
    );
    if (result.stdout.length > 0) {
      throw new ChangeTaskExecutionError(
        "Рабочее дерево Git содержит незакоммиченные или неотслеживаемые изменения",
      );
    }
  } catch (error) {
    if (error instanceof ChangeTaskExecutionError || signal?.aborted) throw error;
    throw new ChangeTaskExecutionError(
      "Не удалось проверить чистоту рабочего дерева Git",
    );
  }
}

export async function readCurrentTaskBranch(
  command: BoundedCommandRunner,
  gitRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["branch", "--show-current"], {
      cwd: gitRoot,
      signal,
    });
    return parseTaskBranch(result.stdout);
  } catch (error) {
    if (error instanceof ChangeTaskExecutionError || signal?.aborted) throw error;
    throw new ChangeTaskExecutionError("Не удалось определить текущую Git-ветку");
  }
}

export async function readTaskHeadCommit(
  command: BoundedCommandRunner,
  gitRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["rev-parse", "HEAD"], {
      cwd: gitRoot,
      signal,
    });
    return commitHashSchema.parse(result.stdout.trim());
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeTaskExecutionError("Не удалось определить текущий Git HEAD");
  }
}

export async function readLocalTaskBranchCommit(
  command: BoundedCommandRunner,
  gitRoot: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const parsedBranch = parseTaskBranch(branch);
  const ref = `refs/heads/${parsedBranch}`;
  try {
    const result = await command(
      "git",
      ["for-each-ref", "--format=%(objectname)%00%(refname)", ref],
      { cwd: gitRoot, signal },
    );
    if (result.stdout.length === 0) return null;
    const [hash, reportedRef, extra] = result.stdout.trimEnd().split("\0");
    if (extra !== undefined || reportedRef !== ref) {
      throw new Error("Некорректный local ref");
    }
    return commitHashSchema.parse(hash);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeTaskExecutionError(
      `Не удалось прочитать локальную ветку «${parsedBranch}»`,
    );
  }
}

export async function readRemoteTaskBranchCommit(
  command: BoundedCommandRunner,
  gitRoot: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string> {
  const commit = await readOptionalRemoteTaskBranchCommit(
    command,
    gitRoot,
    branch,
    signal,
  );
  if (!commit) {
    throw new ChangeTaskExecutionError(
      `Ветка «${parseTaskBranch(branch)}» отсутствует в Git remote origin`,
    );
  }
  return commit;
}

export async function readOptionalRemoteTaskBranchCommit(
  command: BoundedCommandRunner,
  gitRoot: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const parsedBranch = parseTaskBranch(branch);
  const ref = `refs/heads/${parsedBranch}`;
  try {
    const result = await command(
      "git",
      ["ls-remote", "--heads", TASK_REMOTE, ref],
      { cwd: gitRoot, signal },
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
    throw new ChangeTaskExecutionError(
      `Не удалось прочитать ветку «${parsedBranch}» в Git remote origin`,
    );
  }
}

export async function readTaskCommitCount(
  command: BoundedCommandRunner,
  gitRoot: string,
  baseline: string,
  head: string,
  signal: AbortSignal,
): Promise<number> {
  try {
    const result = await command(
      "git",
      ["rev-list", "--count", `${baseline}..${head}`],
      { cwd: gitRoot, signal },
    );
    return z.coerce.number().int().nonnegative().parse(result.stdout.trim());
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChangeTaskExecutionError(
      "Не удалось проверить историю Git implementation-ветки",
    );
  }
}

export async function readTaskChangedPaths(
  command: BoundedCommandRunner,
  gitRoot: string,
  baseline: string,
  head: string,
  signal: AbortSignal,
): Promise<readonly string[]> {
  try {
    const result = await command(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${baseline}..${head}`],
      { cwd: gitRoot, signal },
    );
    return result.stdout.split("\0").filter(Boolean);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChangeTaskExecutionError("Не удалось проверить состав task-коммита");
  }
}

export async function readTaskCommitSubject(
  command: BoundedCommandRunner,
  gitRoot: string,
  head: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["log", "-1", "--format=%s", head], {
      cwd: gitRoot,
      signal,
    });
    return result.stdout.trim();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChangeTaskExecutionError("Не удалось проверить subject task-коммита");
  }
}

export async function assertTaskCommitDescendsFrom(
  command: BoundedCommandRunner,
  gitRoot: string,
  ancestor: string,
  descendant: string,
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await command("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: gitRoot,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeTaskExecutionError(message);
  }
}

export async function resolveTaskRepository(
  command: BoundedCommandRunner,
  gitRoot: string,
  signal?: AbortSignal,
): Promise<ResolvedTaskRepository> {
  let originUrl: string;
  try {
    const result = await command("git", ["remote", "get-url", TASK_REMOTE], {
      cwd: gitRoot,
      signal,
    });
    originUrl = result.stdout.trim();
    if (!originUrl) throw new Error("Пустой URL origin");
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeTaskExecutionError("Git remote origin отсутствует или недоступен");
  }
  const remote = parseGitHubRemote(originUrl);
  try {
    await command("gh", ["auth", "status", "--hostname", remote.host], {
      cwd: gitRoot,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeTaskExecutionError(
      `GitHub CLI недоступен или не авторизован для origin host «${remote.host}»`,
    );
  }

  let repository: z.output<typeof taskRepositorySchema>;
  try {
    const result = await command(
      "gh",
      [
        "repo",
        "view",
        taskRepositoryArgument(remote),
        "--json",
        "nameWithOwner,url",
      ],
      { cwd: gitRoot, signal },
    );
    repository = taskRepositorySchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeTaskExecutionError(
      "Git remote origin не разрешается в доступный GitHub-репозиторий",
    );
  }
  if (
    new URL(repository.url).hostname.toLowerCase() !== remote.host ||
    repository.nameWithOwner.toLowerCase() !== remote.nameWithOwner.toLowerCase()
  ) {
    throw new ChangeTaskExecutionError(
      "GitHub CLI разрешил другой репозиторий вместо Git remote origin",
    );
  }
  return { ...remote, url: repository.url };
}

function parseGitHubRemote(remoteUrl: string): TaskGitHubRemoteIdentity {
  const parsed = parseGitHubRemoteIdentity(remoteUrl);
  if (parsed.kind === "valid") return parsed.identity;
  if (parsed.reason === "host") {
    throw new ChangeTaskExecutionError(
      "Git remote origin содержит недопустимый host",
    );
  }
  if (parsed.reason === "repository") {
    throw new ChangeTaskExecutionError(
      "Git remote origin должен указывать на GitHub-репозиторий owner/name",
    );
  }
  throw new ChangeTaskExecutionError(
    "Git remote origin должен указывать на GitHub",
  );
}
