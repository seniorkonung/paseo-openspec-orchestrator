import { z } from "zod";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import type { ReviewFindingOutcome } from "./review-finding-publication.ts";
import { deliverRootCommit } from "./root-branch-delivery.ts";
import {
  ReviewFindingResolutionError,
  findingResolutionBranchSchema,
  type ActiveReviewFindingReport,
  type FindingResolutionContext,
  type ReviewFindingResolutionBehavior,
  type ReviewFindingResolutionSession,
  type VerifiedReviewFindingResolution,
} from "./review-finding-resolution-model.ts";

const REVIEW_REMOTE = "origin";

type ReportReader = (
  context: FindingResolutionContext,
  signal?: AbortSignal,
) => Promise<ActiveReviewFindingReport>;

export async function readLocalResolutionIfReady<
  Session extends ReviewFindingResolutionSession,
>(
  command: BoundedCommandRunner,
  context: FindingResolutionContext,
  session: Session,
  behavior: ReviewFindingResolutionBehavior<Session>,
  readReport: ReportReader,
  signal: AbortSignal,
): Promise<VerifiedReviewFindingResolution | null> {
  try {
    return await verifyLocalResolution(
      command,
      context,
      session,
      behavior,
      readReport,
      signal,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

export async function verifyCompletedResolution<
  Session extends ReviewFindingResolutionSession,
>(
  command: BoundedCommandRunner,
  context: FindingResolutionContext,
  session: Session,
  behavior: ReviewFindingResolutionBehavior<Session>,
  readReport: ReportReader,
  signal: AbortSignal,
): Promise<VerifiedReviewFindingResolution> {
  const resolution = await verifyLocalResolution(
    command,
    context,
    session,
    behavior,
    readReport,
    signal,
  );
  await deliverRootCommit(
    context.gitRoot,
    context.changeId,
    session.baselineCommit,
    resolution.commit,
    signal,
    command,
  );
  await assertRemoteHead(
    command,
    context.gitRoot,
    session.branch,
    resolution.commit,
    signal,
  );
  return resolution;
}

async function verifyLocalResolution<Session extends ReviewFindingResolutionSession>(
  command: BoundedCommandRunner,
  context: FindingResolutionContext,
  session: Session,
  behavior: ReviewFindingResolutionBehavior<Session>,
  readReport: ReportReader,
  signal: AbortSignal,
): Promise<VerifiedReviewFindingResolution> {
  await assertCurrentBranch(command, context.gitRoot, session.branch, signal);
  await assertCleanWorktree(command, context.gitRoot, signal);
  const report = await readReport(context, signal);
  if (report.findings.some(({ id }) => id === session.findingId)) {
    throw new ReviewFindingResolutionError(
      `Finding «${session.findingId}» всё ещё присутствует в ${behavior.report.fileName}`,
    );
  }
  await assertReviewTracked(command, context, behavior.report.fileName, signal);
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
    throw new ReviewFindingResolutionError(
      `Для finding «${session.findingId}» требуется ровно один отдельный Git-коммит`,
    );
  }

  const changedPaths = await readDiffPaths(
    command,
    context.gitRoot,
    session.baselineCommit,
    head,
    signal,
  );
  const allowedPrefix = `${context.changeRepositoryPath}/`;
  if (
    changedPaths.length === 0 ||
    !changedPaths.includes(context.reviewRepositoryPath) ||
    changedPaths.some((path) => !path.startsWith(allowedPrefix))
  ) {
    throw new ReviewFindingResolutionError(
      `Finding-коммит должен изменять ${behavior.report.fileName} и только файлы выбранного change`,
    );
  }

  const subject = await readCommitSubject(command, context.gitRoot, head, signal);
  const expectedSubject = behavior.publication.commitSubject(session.findingId);
  if (subject !== expectedSubject) {
    throw new ReviewFindingResolutionError(
      `Git-коммит finding должен иметь сообщение «${expectedSubject}»`,
    );
  }

  const outcome: ReviewFindingOutcome = report.acceptedRisks.some(
    ({ originatingFindingId }) => originatingFindingId === session.findingId,
  )
    ? "accepted-risk"
    : "resolved";

  return {
    changeId: context.changeId,
    findingId: session.findingId,
    remainingFindingIds: Object.freeze(report.findings.map(({ id }) => id)),
    commit: head,
    outcome,
  };
}

export async function assertCleanWorktree(
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
      throw new ReviewFindingResolutionError(
        "Рабочее дерево Git содержит незакоммиченные или неотслеживаемые изменения",
      );
    }
  } catch (error) {
    if (error instanceof ReviewFindingResolutionError || signal?.aborted) throw error;
    throw new ReviewFindingResolutionError(
      "Не удалось проверить чистоту рабочего дерева Git",
    );
  }
}

export async function assertCurrentBranch(
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
    const current = findingResolutionBranchSchema.parse(result.stdout);
    if (current !== branch) {
      throw new ReviewFindingResolutionError(
        `Текущая Git-ветка изменилась с «${branch}» на «${current}»`,
      );
    }
  } catch (error) {
    if (error instanceof ReviewFindingResolutionError || signal?.aborted) throw error;
    throw new ReviewFindingResolutionError("Не удалось подтвердить текущую Git-ветку");
  }
}

export async function readHeadCommit(
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
    throw new ReviewFindingResolutionError("Не удалось определить текущий Git HEAD");
  }
}

export async function assertReviewTracked(
  command: BoundedCommandRunner,
  context: FindingResolutionContext,
  reportFileName: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await command("git", ["cat-file", "-e", `HEAD:${context.reviewRepositoryPath}`], {
      cwd: context.gitRoot,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ReviewFindingResolutionError(
      `${reportFileName} не добавлен в текущий Git HEAD`,
    );
  }
}

export async function assertDescendsFromBaseline(
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
    throw new ReviewFindingResolutionError(
      "Текущий Git HEAD больше не продолжает baseline finding-сессии",
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
    throw new ReviewFindingResolutionError("Не удалось проверить историю Git finding");
  }
}

async function readDiffPaths(
  command: BoundedCommandRunner,
  gitRoot: string,
  baselineCommit: string,
  head: string,
  signal: AbortSignal,
): Promise<string[]> {
  try {
    const result = await command(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${baselineCommit}..${head}`],
      { cwd: gitRoot, signal },
    );
    return result.stdout.split("\0").filter(Boolean);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ReviewFindingResolutionError(
      "Не удалось проверить состав Git-коммита finding",
    );
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
    throw new ReviewFindingResolutionError(
      "Не удалось проверить сообщение Git-коммита finding",
    );
  }
}

export async function assertRemoteHead(
  command: BoundedCommandRunner,
  gitRoot: string,
  branch: string,
  expectedHead: string,
  signal?: AbortSignal,
): Promise<void> {
  const ref = `refs/heads/${branch}`;
  try {
    const result = await command(
      "git",
      ["ls-remote", "--exit-code", "--heads", REVIEW_REMOTE, ref],
      { cwd: gitRoot, signal },
    );
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (lines.length !== 1) throw new Error("Неоднозначный remote ref");
    const [hash, reportedRef, extra] = lines[0]?.split("\t") ?? [];
    if (
      extra !== undefined ||
      reportedRef !== ref ||
      commitHashSchema.parse(hash) !== expectedHead
    ) {
      throw new Error("Remote HEAD не совпадает");
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ReviewFindingResolutionError(
      `Git remote origin не содержит текущий HEAD ветки «${branch}»`,
    );
  }
}
