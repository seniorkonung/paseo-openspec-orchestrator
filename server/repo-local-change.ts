import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import { runWorkspaceMiseCommand } from "./mise-toolchain.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";

const MAX_PATH_LENGTH = 8_192;

export interface RepoLocalChangePaths {
  readonly workspaceRoot: string;
  readonly changeRoot: string;
  readonly gitRoot: string;
  readonly changeRepositoryPath: string;
}

const repoLocalStatusSchema = z
  .object({
    changeName: openSpecChangeIdSchema,
    changeRoot: z.string().trim().min(1).max(MAX_PATH_LENGTH),
    actionContext: z
      .object({ mode: z.literal("repo-local"), sourceOfTruth: z.literal("repo") })
      .loose(),
  })
  .loose();

/**
 * Определяет каталог change по `openspec status`. Change должен храниться в
 * репозитории рабочей области; ошибки создаёт фабрика вызывающего этапа.
 */
export async function readRepoLocalChangePaths(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  changeId: string,
  createError: (message: string) => Error,
  signal?: AbortSignal,
): Promise<RepoLocalChangePaths> {
  let stdout: string;
  try {
    ({ stdout } = await runWorkspaceMiseCommand(
      command,
      workspaceDirectory,
      "openspec",
      ["status", "--change", changeId, "--json"],
      signal,
    ));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw createError(`Не удалось прочитать OpenSpec change «${changeId}»`);
  }

  let status: z.output<typeof repoLocalStatusSchema>;
  try {
    status = repoLocalStatusSchema.parse(JSON.parse(stdout) as unknown);
  } catch {
    throw createError("OpenSpec вернул некорректный status change");
  }
  if (status.changeName !== changeId) {
    throw createError("OpenSpec вернул status другого change");
  }

  try {
    return await resolveRepoLocalChangePaths({
      command,
      workspaceDirectory,
      reportedChangeRoot: status.changeRoot,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw createError("Не удалось безопасно определить change root");
  }
}

export interface ResolveRepoLocalChangePathsRequest {
  readonly command: BoundedCommandRunner;
  readonly workspaceDirectory: string;
  readonly reportedChangeRoot: string;
  readonly signal?: AbortSignal;
  readonly resolveRealPath?: typeof realpath;
}

export async function resolveRepoLocalChangePaths(
  request: ResolveRepoLocalChangePathsRequest,
): Promise<RepoLocalChangePaths> {
  const resolveRealPath = request.resolveRealPath ?? realpath;
  const workspaceRoot = await resolveRealPath(request.workspaceDirectory);
  const changeRoot = await resolveRealPath(
    isAbsolute(request.reportedChangeRoot)
      ? request.reportedChangeRoot
      : resolve(workspaceRoot, request.reportedChangeRoot),
  );
  if (!(await stat(changeRoot)).isDirectory()) {
    throw new Error("Change root не является директорией");
  }
  assertContainedPath(workspaceRoot, changeRoot, "Change root");

  const gitRootOutput = await request.command("git", ["rev-parse", "--show-toplevel"], {
    cwd: workspaceRoot,
    signal: request.signal,
  });
  const reportedGitRoot = z
    .string()
    .trim()
    .min(1)
    .max(MAX_PATH_LENGTH)
    .parse(gitRootOutput.stdout);
  const gitRoot = await resolveRealPath(reportedGitRoot);
  const changeRepositoryPath = assertContainedPath(gitRoot, changeRoot, "Change root")
    .split(sep)
    .join("/");

  return { workspaceRoot, changeRoot, gitRoot, changeRepositoryPath };
}

function assertContainedPath(root: string, candidate: string, label: string): string {
  const path = relative(root, candidate);
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path === ".." ||
    path.startsWith(`..${sep}`)
  ) {
    throw new Error(`${label} находится за пределами допустимого каталога`);
  }
  return path;
}
