import type { lstat } from "node:fs/promises";
import { z } from "zod";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import type { TaskScopeCheck } from "./phase-work.ts";
import type { ReviewFindingOutcome } from "./review-finding-publication.ts";
import { deliverRootCommit } from "./root-branch-delivery.ts";
import {
  commitFindingDecisions,
  findingDecisionsRepositoryPath,
  readFindingDecisionsAt,
} from "./review-finding-decision-git.ts";
import {
  FindingDecisionsError,
  decisionsAfterBlock,
  decisionsAfterResolution,
  sameFindingDecisions,
  type ExecutableFindingDecisionRecord,
  type FindingDecisionRecord,
} from "./review-finding-decision-model.ts";
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
  assertTaskScope: TaskScopeCheck,
  signal: AbortSignal,
): Promise<VerifiedReviewFindingResolution | null> {
  try {
    return await verifyLocalResolution(
      command,
      context,
      session,
      behavior,
      readReport,
      assertTaskScope,
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
  assertTaskScope: TaskScopeCheck,
  signal: AbortSignal,
): Promise<VerifiedReviewFindingResolution> {
  const resolution = await verifyLocalResolution(
    command,
    context,
    session,
    behavior,
    readReport,
    assertTaskScope,
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
  assertTaskScope: TaskScopeCheck,
  signal: AbortSignal,
): Promise<VerifiedReviewFindingResolution> {
  await assertCurrentBranch(command, context.gitRoot, session.branch, signal);
  await assertCleanWorktree(command, context.gitRoot, signal);
  const report = await readReport(context, signal);
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
  if (commitCount < 1) {
    throw new ReviewFindingResolutionError(
      `Для finding «${session.findingId}» требуется хотя бы один новый Git-коммит`,
    );
  }

  const changedPaths = await readDiffPaths(
    command,
    context.gitRoot,
    session.baselineCommit,
    head,
    signal,
  );
  const decisionsPath = findingDecisionsRepositoryPath(
    context.changeRepositoryPath,
    behavior.publication.kind,
  );
  const baselineRecords = await readDecisions(
    command, context, behavior, session.baselineCommit, signal,
  );
  const decision = await readFindingDecision(command, context, session, behavior, signal);
  const headRecords = await readDecisions(command, context, behavior, head, signal);
  const base = {
    changeId: context.changeId,
    findingId: session.findingId,
    remainingFindingIds: Object.freeze(report.findings.map(({ id }) => id)),
    commit: head,
  };

  if (report.findings.some(({ id }) => id === session.findingId)) {
    // Finding остаётся открытой только при препятствии, которое оркестратор
    // записал отдельным коммитом решений без правок артефактов.
    const headDecision = headRecords.find(({ findingId }) => findingId === session.findingId)
      ?.decision;
    if (
      headDecision?.kind === "blocked" &&
      changedPaths.length === 1 &&
      changedPaths[0] === decisionsPath &&
      sameFindingDecisions(
        headRecords,
        decisionsAfterBlock(baselineRecords, session.findingId, headDecision.reason, report.findings),
      )
    ) {
      return { ...base, outcome: "blocked", reason: headDecision.reason };
    }
    throw new ReviewFindingResolutionError(
      `Finding «${session.findingId}» всё ещё присутствует в ${behavior.report.fileName}`,
    );
  }

  if (!changedPaths.includes(context.reviewRepositoryPath)) {
    throw new ReviewFindingResolutionError(
      `Finding-коммит должен изменять ${behavior.report.fileName}`,
    );
  }
  if (
    !sameFindingDecisions(
      headRecords,
      decisionsAfterResolution(baselineRecords, session.findingId, report.findings),
    )
  ) {
    throw new ReviewFindingResolutionError(
      `Удалите из ${decisionsPath} раздел finding «${session.findingId}» и разделы findings, которых больше нет в ${behavior.report.fileName}; решения по открытым findings не меняйте`,
    );
  }
  // Проверка до публикации: задача в фазе, которую планирует оркестратор,
  // отменила бы её фокусное планирование.
  await assertTaskScope(signal);

  const outcome: ReviewFindingOutcome = report.acceptedRisks.some(
    ({ originatingFindingId }) => originatingFindingId === session.findingId,
  )
    ? "accepted-risk"
    : "resolved";
  if (outcome === "accepted-risk" && decision.decision.kind !== "accept-risk") {
    throw new ReviewFindingResolutionError(
      `Пользователь решил устранить finding «${session.findingId}», а не принять её риск`,
    );
  }
  return { ...base, outcome };
}

/**
 * Решение пользователя, от которого начата сессия исполнения. Оно читается из
 * baseline: сессия сама удаляет его раздел, а прочие правки файла запрещены.
 */
export async function readFindingDecision<Session extends ReviewFindingResolutionSession>(
  command: BoundedCommandRunner,
  context: FindingResolutionContext,
  session: Session,
  behavior: ReviewFindingResolutionBehavior<Session>,
  signal?: AbortSignal,
): Promise<ExecutableFindingDecisionRecord> {
  const records = await readDecisions(command, context, behavior, session.baselineCommit, signal);
  const record = records.find(({ findingId }) => findingId === session.findingId);
  if (!record || record.decision.kind === "blocked") {
    throw new ReviewFindingResolutionError(
      `Для finding «${session.findingId}» не записано решение пользователя`,
    );
  }
  return { ...record, decision: record.decision };
}

export async function readDecisions<Session extends ReviewFindingResolutionSession>(
  command: BoundedCommandRunner,
  context: FindingResolutionContext,
  behavior: ReviewFindingResolutionBehavior<Session>,
  commit: string,
  signal?: AbortSignal,
): Promise<readonly FindingDecisionRecord[]> {
  try {
    return await readFindingDecisionsAt(
      command,
      context.gitRoot,
      commit,
      findingDecisionsRepositoryPath(context.changeRepositoryPath, behavior.publication.kind),
      behavior.publication.kind,
      signal,
    );
  } catch (error) {
    if (error instanceof FindingDecisionsError) {
      throw new ReviewFindingResolutionError(error.message);
    }
    throw error;
  }
}

/**
 * Возвращает finding к решению пользователя: оркестратор сам записывает
 * препятствие в файл решений. Сессия исполнения при этом не коммитит ничего.
 */
export async function recordBlockedFindingDecision<
  Session extends ReviewFindingResolutionSession,
>(
  command: BoundedCommandRunner,
  context: FindingResolutionContext,
  session: Session,
  behavior: ReviewFindingResolutionBehavior<Session>,
  readReport: ReportReader,
  reason: string,
  signal: AbortSignal,
  inspectPath?: typeof lstat,
): Promise<void> {
  await assertCurrentBranch(command, context.gitRoot, session.branch, signal);
  await assertCleanWorktree(command, context.gitRoot, signal);
  const head = await readHeadCommit(command, context.gitRoot, signal);
  if (head !== session.baselineCommit) {
    throw new ReviewFindingResolutionError(
      `Препятствие finding «${session.findingId}» записывается только без новых коммитов сессии; опишите пользователю, что уже закоммичено`,
    );
  }
  await readFindingDecision(command, context, session, behavior, signal);
  const records = await readDecisions(command, context, behavior, head, signal);
  const report = await readReport(context, signal);
  try {
    await commitFindingDecisions({
      command,
      paths: context,
      kind: behavior.publication.kind,
      records: decisionsAfterBlock(records, session.findingId, reason, report.findings),
      subject: behavior.decisions.blockedCommitSubject(session.findingId),
      signal,
      ...(inspectPath === undefined ? {} : { inspectPath }),
    });
  } catch (error) {
    if (error instanceof FindingDecisionsError) {
      throw new ReviewFindingResolutionError(error.message);
    }
    throw error;
  }
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
