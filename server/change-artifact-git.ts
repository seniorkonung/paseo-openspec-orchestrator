import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import {
  ChangeArtifactCreationError,
  commitHashSchema,
  type PendingArtifactSession,
} from "./change-artifact-model.ts";
import { isCommitAncestor } from "./git-ancestry.ts";

export interface ArtifactGitStatus {
  readonly gitRoot: string;
  readonly artifactPaths: ReadonlyMap<
    string,
    { readonly existingOutputPaths: readonly string[] }
  >;
}

export async function verifyArtifactCommit(
  command: BoundedCommandRunner,
  status: ArtifactGitStatus,
  session: PendingArtifactSession,
  signal: AbortSignal,
): Promise<void> {
  await assertCleanWorktree(command, status.gitRoot, signal);
  const head = await readHeadCommit(command, status.gitRoot, signal);
  await assertDescendsFromBaseline(
    command,
    status.gitRoot,
    session.baselineCommit,
    head,
    signal,
  );
  let commitCount: number;
  try {
    const result = await command(
      "git",
      ["rev-list", "--count", `${session.baselineCommit}..${head}`],
      { cwd: status.gitRoot, signal },
    );
    commitCount = z.coerce.number().int().nonnegative().parse(result.stdout.trim());
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChangeArtifactCreationError("Не удалось проверить историю Git артефакта");
  }
  if (commitCount < 1) {
    throw new ChangeArtifactCreationError(
      "Для текущего артефакта требуется хотя бы один новый Git-коммит",
    );
  }

  const expectedPaths = status.artifactPaths.get(session.artifactId)?.existingOutputPaths;
  if (!expectedPaths || expectedPaths.length === 0) {
    throw new ChangeArtifactCreationError(
      `OpenSpec не подтвердил файлы артефакта «${session.artifactId}»`,
    );
  }
  const allowed = new Set(
    expectedPaths.map((path) => repositoryPath(status.gitRoot, path, session.artifactId)),
  );

  const changedPaths = await readChangedPaths(
    command,
    status.gitRoot,
    session.baselineCommit,
    head,
    signal,
  );
  if (changedPaths.length === 0 || changedPaths.some((path) => !allowed.has(path))) {
    throw new ChangeArtifactCreationError(
      "Git-коммит должен содержать только файлы ожидаемого OpenSpec-артефакта",
    );
  }
}

/**
 * Описывает, чем коммиты после baseline уже нарушают контракт artifact-этапа:
 * история переписана либо в диапазон попали файлы вне артефакта. Такой
 * диапазон этап не примет ни при каком продолжении. Незакоммиченная или ещё
 * не начатая работа нарушением не считается.
 */
export async function describeArtifactRangeViolation(
  command: BoundedCommandRunner,
  status: ArtifactGitStatus,
  session: PendingArtifactSession,
  signal: AbortSignal,
): Promise<string | null> {
  const head = await readHeadCommit(command, status.gitRoot, signal);
  if (!(await isCommitAncestor(command, status.gitRoot, session.baselineCommit, head, signal))) {
    return "Текущий Git HEAD больше не продолжает сохранённый исходный коммит";
  }
  const allowed = new Set(
    (status.artifactPaths.get(session.artifactId)?.existingOutputPaths ?? []).map((path) =>
      repositoryPath(status.gitRoot, path, session.artifactId),
    ),
  );
  const changedPaths = await readChangedPaths(command, status.gitRoot, session.baselineCommit, head, signal);
  return changedPaths.some((path) => !allowed.has(path))
    ? "После baseline artifact-сессии появились коммиты вне файлов артефакта"
    : null;
}

async function readChangedPaths(
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
    throw new ChangeArtifactCreationError("Не удалось проверить состав Git-коммита артефакта");
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
      throw new ChangeArtifactCreationError(
        "Рабочее дерево Git содержит незакоммиченные или неотслеживаемые изменения",
      );
    }
  } catch (error) {
    if (error instanceof ChangeArtifactCreationError || signal?.aborted) throw error;
    throw new ChangeArtifactCreationError("Не удалось проверить чистоту рабочего дерева Git");
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
    throw new ChangeArtifactCreationError("Не удалось определить текущий Git-коммит");
  }
}

async function assertDescendsFromBaseline(
  command: BoundedCommandRunner,
  gitRoot: string,
  baselineCommit: string,
  head: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await command("git", ["merge-base", "--is-ancestor", baselineCommit, head], {
      cwd: gitRoot,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChangeArtifactCreationError(
      "Текущий Git HEAD больше не продолжает сохранённый исходный коммит",
    );
  }
}

function repositoryPath(gitRoot: string, candidate: string, artifactId: string): string {
  const path = relative(gitRoot, candidate);
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path === ".." ||
    path.startsWith(`..${sep}`)
  ) {
    throw new ChangeArtifactCreationError(
      `Путь артефакта «${artifactId}» находится за пределами Git-репозитория`,
    );
  }
  return path.split(sep).join("/");
}
