import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import { runWorkspaceMiseCommand } from "./mise-toolchain.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import { resolveRepoLocalChangePaths } from "./repo-local-change.ts";

const REVIEW_FILE_NAME = "implementation-review.md";

const statusSchema = z
  .object({
    changeName: openSpecChangeIdSchema,
    changeRoot: z.string().trim().min(1).max(8_192),
    actionContext: z
      .object({ mode: z.literal("repo-local"), sourceOfTruth: z.literal("repo") })
      .loose(),
  })
  .loose();

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

  let status: z.output<typeof statusSchema>;
  try {
    status = statusSchema.parse(JSON.parse(stdout) as unknown);
  } catch {
    throw createError("OpenSpec вернул некорректный status change");
  }
  if (status.changeName !== changeId) {
    throw createError("OpenSpec вернул status другого change");
  }

  try {
    const paths = await resolveRepoLocalChangePaths({
      command,
      workspaceDirectory,
      reportedChangeRoot: status.changeRoot,
      signal,
      resolveRealPath: realpath,
    });
    return {
      gitRoot: paths.gitRoot,
      changeRoot: paths.changeRoot,
      reviewPath: resolve(paths.changeRoot, REVIEW_FILE_NAME),
      reviewRepositoryPath: `${paths.changeRepositoryPath}/${REVIEW_FILE_NAME}`,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    throw createError("Не удалось безопасно определить change root");
  }
}
