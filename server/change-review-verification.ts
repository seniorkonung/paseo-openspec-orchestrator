import { lstat, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { z } from "zod";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  ChangeReviewError,
  parseReviewChangeId,
  reviewCommitSubject,
  reviewPublicationTarget,
  type CompletedChangeReview,
  type PendingReviewSession,
  type ReviewContext,
} from "./change-review-model.ts";
import { planningBranchSchema } from "./change-branch.ts";
import { verifyReviewPullRequest } from "./change-review-publication.ts";
import { runWorkspaceMiseCommand } from "./mise-toolchain.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import { resolveRepoLocalChangePaths } from "./repo-local-change.ts";

const REVIEW_FILE_NAME = "review.md";
const MAX_PATH_LENGTH = 8_192;

const reviewStatusSchema = z
  .object({
    changeName: openSpecChangeIdSchema,
    changeRoot: z.string().trim().min(1).max(MAX_PATH_LENGTH),
    actionContext: z
      .object({
        mode: z.literal("repo-local"),
        sourceOfTruth: z.literal("repo"),
      })
      .loose(),
  })
  .loose();

export interface ChangeReviewVerification {
  readContext(
    workspaceDirectory: string,
    changeId: string,
    signal?: AbortSignal,
  ): Promise<ReviewContext>;
  isLocalCommitReady(
    context: ReviewContext,
    session: PendingReviewSession,
    signal: AbortSignal,
  ): Promise<boolean>;
  verifyCompleted(
    context: ReviewContext,
    session: PendingReviewSession,
    signal: AbortSignal,
  ): Promise<CompletedChangeReview>;
}

export interface ChangeReviewVerificationOptions {
  readonly command: BoundedCommandRunner;
  readonly resolveRealPath?: typeof realpath;
  readonly inspectPath?: typeof lstat;
}

export function createChangeReviewVerification(
  options: ChangeReviewVerificationOptions,
): ChangeReviewVerification {
  const { command } = options;
  const resolveRealPath = options.resolveRealPath ?? realpath;
  const inspectPath = options.inspectPath ?? lstat;

  const inspectReview = async (
    context: ReviewContext,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    let reviewStat;
    try {
      reviewStat = await inspectPath(context.reviewPath);
    } catch (error) {
      if (isMissingPathError(error)) return false;
      if (signal?.aborted) throw error;
      throw new ChangeReviewError("Не удалось проверить review.md выбранного change");
    }
    if (!reviewStat.isFile() || reviewStat.isSymbolicLink() || reviewStat.size === 0) {
      throw new ChangeReviewError(
        "review.md должен быть непустым обычным файлом внутри выбранного change",
      );
    }

    try {
      const resolvedReviewPath = await resolveRealPath(context.reviewPath);
      const pathInsideChange = relative(context.changeRoot, resolvedReviewPath);
      if (pathInsideChange !== REVIEW_FILE_NAME) {
        throw new Error("Review path вышел за пределы change");
      }
    } catch (error) {
      if (error instanceof ChangeReviewError || signal?.aborted) throw error;
      throw new ChangeReviewError(
        "review.md находится за пределами выбранного OpenSpec change",
      );
    }
    return true;
  };

  const readContext = async (
    workspaceDirectory: string,
    changeId: string,
    signal?: AbortSignal,
  ): Promise<ReviewContext> => {
    const parsedChangeId = parseReviewChangeId(changeId);
    let stdout: string;
    try {
      ({ stdout } = await runWorkspaceMiseCommand(
        command,
        workspaceDirectory,
        "openspec",
        ["status", "--change", parsedChangeId, "--json"],
        signal,
      ));
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ChangeReviewError(
        `Не удалось прочитать OpenSpec change «${parsedChangeId}» для review`,
      );
    }

    let status: z.output<typeof reviewStatusSchema>;
    try {
      status = reviewStatusSchema.parse(JSON.parse(stdout) as unknown);
    } catch {
      throw new ChangeReviewError(
        `OpenSpec вернул некорректное состояние change «${parsedChangeId}»`,
      );
    }
    if (status.changeName !== parsedChangeId) {
      throw new ChangeReviewError(
        `OpenSpec вернул другой change вместо «${parsedChangeId}»`,
      );
    }

    let paths;
    try {
      paths = await resolveRepoLocalChangePaths({
        command,
        workspaceDirectory,
        reportedChangeRoot: status.changeRoot,
        signal,
        resolveRealPath,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ChangeReviewError(
        `Не удалось безопасно определить каталог change «${parsedChangeId}»`,
      );
    }

    return {
      ...paths,
      changeId: parsedChangeId,
      reviewPath: resolve(paths.changeRoot, REVIEW_FILE_NAME),
      reviewRepositoryPath: `${paths.changeRepositoryPath}/${REVIEW_FILE_NAME}`,
    };
  };

  const verifyLocalReviewCommit = async (
    context: ReviewContext,
    session: PendingReviewSession,
    signal: AbortSignal,
  ): Promise<string> => {
    await assertCurrentBranch(command, context.gitRoot, session.reviewBranch, signal);
    await assertCleanWorktree(command, context.gitRoot, signal);
    if (!(await inspectReview(context, signal))) {
      throw new ChangeReviewError("Review ещё не создал review.md");
    }
    await assertReviewTracked(command, context, signal);
    const head = await readHeadCommit(command, context.gitRoot, signal);
    await assertDescendsFromBaseline(
      command,
      context.gitRoot,
      session.baselineCommit,
      signal,
    );

    const commitCount = await readCommitCount(
      command,
      context.gitRoot,
      session.baselineCommit,
      head,
      signal,
    );
    if (commitCount !== 1) {
      throw new ChangeReviewError("Для review требуется ровно один отдельный Git-коммит");
    }

    const [changedPaths, addedPaths] = await Promise.all([
      readDiffPaths(command, context.gitRoot, session.baselineCommit, head, [], signal),
      readDiffPaths(
        command,
        context.gitRoot,
        session.baselineCommit,
        head,
        ["--diff-filter=A"],
        signal,
      ),
    ]);
    const addedPathSet = new Set(addedPaths);
    const allowedPrefix = `${context.changeRepositoryPath}/`;
    if (
      !changedPaths.includes(context.reviewRepositoryPath) ||
      changedPaths.some((path) => !path.startsWith(allowedPrefix))
    ) {
      throw new ChangeReviewError(
        "Review-коммит должен содержать review.md и только новые файлы внутри выбранного change",
      );
    }
    if (
      changedPaths.some(
        (path) => path !== context.reviewRepositoryPath && !addedPathSet.has(path),
      )
    ) {
      throw new ChangeReviewError(
        "Review-коммит не должен изменять существующие planning-артефакты",
      );
    }

    const subject = await readCommitSubject(command, context.gitRoot, head, signal);
    const expectedSubject = reviewCommitSubject(context.changeId);
    if (subject !== expectedSubject) {
      throw new ChangeReviewError(
        `Git-коммит review должен иметь сообщение «${expectedSubject}»`,
      );
    }
    return head;
  };

  return {
    readContext,

    async isLocalCommitReady(context, session, signal) {
      try {
        await verifyLocalReviewCommit(context, session, signal);
        return true;
      } catch (error) {
        if (signal.aborted) throw error;
        return false;
      }
    },

    async verifyCompleted(context, session, signal) {
      const head = await verifyLocalReviewCommit(context, session, signal);
      const pullRequest = await verifyReviewPullRequest(
        context.gitRoot,
        reviewPublicationTarget(session),
        context.changeId,
        head,
        signal,
        command,
      );
      return {
        changeId: context.changeId,
        reviewPath: context.reviewRepositoryPath,
        branch: session.reviewBranch,
        pullRequest,
      };
    },
  };
}

async function assertCleanWorktree(
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
      throw new ChangeReviewError(
        "Рабочее дерево Git содержит незакоммиченные или неотслеживаемые изменения",
      );
    }
  } catch (error) {
    if (error instanceof ChangeReviewError || signal?.aborted) throw error;
    throw new ChangeReviewError("Не удалось проверить чистоту рабочего дерева Git");
  }
}

async function assertCurrentBranch(
  command: BoundedCommandRunner,
  gitRoot: string,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await command("git", ["branch", "--show-current"], {
      cwd: gitRoot,
      signal,
    });
    const current = planningBranchSchema.parse(result.stdout.trim());
    if (current !== branch) {
      throw new ChangeReviewError(
        `Текущая Git-ветка изменилась с «${branch}» на «${current}»`,
      );
    }
  } catch (error) {
    if (error instanceof ChangeReviewError || signal?.aborted) throw error;
    throw new ChangeReviewError("Не удалось подтвердить текущую Git-ветку");
  }
}

async function readHeadCommit(
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
    throw new ChangeReviewError("Не удалось определить текущий Git HEAD");
  }
}

async function assertReviewTracked(
  command: BoundedCommandRunner,
  context: ReviewContext,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await command("git", ["cat-file", "-e", `HEAD:${context.reviewRepositoryPath}`], {
      cwd: context.gitRoot,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewError("review.md не добавлен в текущий Git HEAD");
  }
}

async function assertDescendsFromBaseline(
  command: BoundedCommandRunner,
  gitRoot: string,
  baselineCommit: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await command("git", ["merge-base", "--is-ancestor", baselineCommit, "HEAD"], {
      cwd: gitRoot,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeReviewError(
      "Текущий Git HEAD больше не продолжает baseline review-сессии",
    );
  }
}

async function readCommitCount(
  command: BoundedCommandRunner,
  gitRoot: string,
  baselineCommit: string,
  head: string,
  signal: AbortSignal,
): Promise<number> {
  try {
    const result = await command(
      "git",
      ["rev-list", "--count", `${baselineCommit}..${head}`],
      { cwd: gitRoot, signal },
    );
    return z.coerce.number().int().nonnegative().parse(result.stdout.trim());
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChangeReviewError("Не удалось проверить историю Git review");
  }
}

async function readDiffPaths(
  command: BoundedCommandRunner,
  gitRoot: string,
  baselineCommit: string,
  head: string,
  extraArguments: readonly string[],
  signal: AbortSignal,
): Promise<string[]> {
  try {
    const result = await command(
      "git",
      [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        ...extraArguments,
        `${baselineCommit}..${head}`,
      ],
      { cwd: gitRoot, signal },
    );
    return result.stdout.split("\0").filter(Boolean);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChangeReviewError("Не удалось проверить состав Git-коммита review");
  }
}

async function readCommitSubject(
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
    throw new ChangeReviewError("Не удалось проверить сообщение Git-коммита review");
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      Reflect.get(error, "code") === "ENOENT",
  );
}
