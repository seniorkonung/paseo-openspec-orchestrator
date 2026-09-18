import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { abortError } from "./agent-session-control.ts";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import { runWorkspaceMiseCommand } from "./mise-toolchain.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import { resolveRepoLocalChangePaths } from "./repo-local-change.ts";
import {
  ReviewFindingResolutionError,
  type ActiveReviewFindingReport,
  type FindingResolutionContext,
  type ReviewFindingResolutionBehavior,
  type ReviewFindingResolutionSession,
} from "./review-finding-resolution-model.ts";

const MAX_PATH_LENGTH = 8_192;

const resolutionStatusSchema = z
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

export interface ReviewFindingContextReader {
  readContext(
    workspaceDirectory: string,
    changeId: string,
    signal?: AbortSignal,
  ): Promise<FindingResolutionContext>;
  readReport(
    context: FindingResolutionContext,
    signal?: AbortSignal,
  ): Promise<ActiveReviewFindingReport>;
  reportExists(
    context: FindingResolutionContext,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface ReviewFindingContextReaderOptions<
  Session extends ReviewFindingResolutionSession,
> {
  readonly command: BoundedCommandRunner;
  readonly report: ReviewFindingResolutionBehavior<Session>["report"];
  readonly resolveRealPath?: typeof realpath;
  readonly inspectPath?: typeof lstat;
}

export function createReviewFindingContextReader<
  Session extends ReviewFindingResolutionSession,
>(
  options: ReviewFindingContextReaderOptions<Session>,
): ReviewFindingContextReader {
  const { command, report } = options;
  const resolveRealPath = options.resolveRealPath ?? realpath;
  const inspectPath = options.inspectPath ?? lstat;

  return {
    async readContext(workspaceDirectory, changeId, signal) {
      const parsedChangeId = parseChangeId(changeId);
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
        throw new ReviewFindingResolutionError(
          `Не удалось прочитать OpenSpec change «${parsedChangeId}» перед устранением findings`,
        );
      }

      let status: z.output<typeof resolutionStatusSchema>;
      try {
        status = resolutionStatusSchema.parse(JSON.parse(stdout) as unknown);
      } catch {
        throw new ReviewFindingResolutionError(
          `OpenSpec вернул некорректное состояние change «${parsedChangeId}»`,
        );
      }
      if (status.changeName !== parsedChangeId) {
        throw new ReviewFindingResolutionError(
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
        throw new ReviewFindingResolutionError(
          `Не удалось безопасно определить каталог change «${parsedChangeId}»`,
        );
      }

      return {
        ...paths,
        changeId: parsedChangeId,
        reviewPath: resolve(paths.changeRoot, report.fileName),
        reviewRepositoryPath: `${paths.changeRepositoryPath}/${report.fileName}`,
      };
    },

    async readReport(context, signal) {
      throwIfOptionalSignalAborted(signal);
      const result = await report.read(
        {
          reviewPath: context.reviewPath,
          changeRoot: context.changeRoot,
          expectedChangeId: context.changeId,
          inspectPath,
          resolveRealPath,
        },
        signal,
      );
      throwIfOptionalSignalAborted(signal);
      return result;
    },

    async reportExists(context, signal) {
      throwIfOptionalSignalAborted(signal);
      try {
        await inspectPath(context.reviewPath);
        throwIfOptionalSignalAborted(signal);
        return true;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (isNodeError(error) && error.code === "ENOENT") return false;
        throw new ReviewFindingResolutionError(
          `Не удалось проверить наличие отчёта ${report.fileName}`,
        );
      }
    },
  };
}

export function parseChangeId(changeId: string): string {
  const parsed = openSpecChangeIdSchema.safeParse(changeId);
  if (!parsed.success) {
    throw new ReviewFindingResolutionError("Change ID должен быть в kebab-case");
  }
  return parsed.data;
}

function throwIfOptionalSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
