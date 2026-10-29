import { resolve } from "node:path";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import { readRepoLocalChangePaths } from "./repo-local-change.ts";

const REVIEW_FILE_NAME = "implementation-review.md";

export interface ImplementationReviewContext {
  readonly gitRoot: string;
  readonly changeRoot: string;
  readonly reviewPath: string;
  readonly reviewRepositoryPath: string;
}

export async function readImplementationReviewContext(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  changeId: string,
  createError: (message: string) => Error,
  signal?: AbortSignal,
): Promise<ImplementationReviewContext> {
  const paths = await readRepoLocalChangePaths(
    command,
    workspaceDirectory,
    changeId,
    createError,
    signal,
  );
  return {
    gitRoot: paths.gitRoot,
    changeRoot: paths.changeRoot,
    reviewPath: resolve(paths.changeRoot, REVIEW_FILE_NAME),
    reviewRepositoryPath: `${paths.changeRepositoryPath}/${REVIEW_FILE_NAME}`,
  };
}
