import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { BoundedCommandRunner } from "./bounded-command.ts";

const MAX_PATH_LENGTH = 8_192;

export interface RepoLocalChangePaths {
  readonly workspaceRoot: string;
  readonly changeRoot: string;
  readonly gitRoot: string;
  readonly changeRepositoryPath: string;
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
