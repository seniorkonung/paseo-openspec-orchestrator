import { z } from "zod";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  changeBranchFor,
  changeBranchSchema,
  implementationBranchFor,
  implementationBranchSchema,
} from "./change-branch.ts";
import {
  implementationRepositorySchema,
  implementationRunSchema,
  type ImplementationRun,
} from "./implementation-run-model.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  assertCleanReviewWorktree,
  listReviewPullRequests,
  readCurrentReviewBranch,
  readLocalReviewBranchCommit,
  readOptionalRemoteReviewBranchCommit,
  readRemoteReviewBranchCommit,
  readReviewHeadCommit,
  resolveReviewRepository,
} from "./review-publication-gateway.ts";
import { repositoryArgument } from "./review-publication-model.ts";

export const pendingImplementationBranchSessionSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    changeBranch: changeBranchSchema,
    implementationBranch: implementationBranchSchema,
    rootBaselineCommit: commitHashSchema,
    repository: implementationRepositorySchema,
  })
  .strict()
  .superRefine((session, context) => {
    if (session.changeBranch !== changeBranchFor(session.changeId)) {
      context.addIssue({
        code: "custom",
        path: ["changeBranch"],
        message: "Корневая ветка не соответствует change",
      });
    }
    if (session.implementationBranch !== implementationBranchFor(session.changeId)) {
      context.addIssue({
        code: "custom",
        path: ["implementationBranch"],
        message: "Implementation-ветка не соответствует change",
      });
    }
  });

export type PendingImplementationBranchSession = z.infer<
  typeof pendingImplementationBranchSessionSchema
>;

export interface ImplementationBranchService {
  prepare(
    workspaceDirectory: string,
    changeId: string,
    changeBranch: string,
    signal?: AbortSignal,
  ): Promise<PendingImplementationBranchSession>;
  activate(
    workspaceDirectory: string,
    session: PendingImplementationBranchSession,
    signal?: AbortSignal,
  ): Promise<ImplementationRun>;
}

export interface ImplementationBranchServiceOptions {
  readonly command?: BoundedCommandRunner;
}

export class ImplementationBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImplementationBranchError";
  }
}

export function createImplementationBranchService(
  options: ImplementationBranchServiceOptions = {},
): ImplementationBranchService {
  const command = options.command ?? runBoundedCommand;

  return {
    async prepare(workspaceDirectory, changeIdInput, changeBranchInput, signal) {
      const changeId = openSpecChangeIdSchema.parse(changeIdInput);
      const changeBranch = changeBranchSchema.parse(changeBranchInput);
      if (changeBranch !== changeBranchFor(changeId)) {
        throw new ImplementationBranchError(
          "Корневая ветка не соответствует выбранному OpenSpec change",
        );
      }
      await assertCleanReviewWorktree(command, workspaceDirectory, signal);
      const [currentBranch, rootBaselineCommit, remoteRoot, repository] =
        await Promise.all([
          readCurrentReviewBranch(command, workspaceDirectory, signal),
          readReviewHeadCommit(command, workspaceDirectory, signal),
          readRemoteReviewBranchCommit(command, workspaceDirectory, changeBranch, signal),
          resolveReviewRepository(command, workspaceDirectory, signal),
        ]);
      if (currentBranch !== changeBranch) {
        throw new ImplementationBranchError(
          `Перед implementation требуется корневая ветка «${changeBranch}»`,
        );
      }
      if (remoteRoot !== rootBaselineCommit) {
        throw new ImplementationBranchError(
          `Local и origin/${changeBranch} должны указывать на один baseline`,
        );
      }

      const implementationBranch = implementationBranchFor(changeId);
      const [localImplementation, remoteImplementation, previousPullRequests] =
        await Promise.all([
          readLocalReviewBranchCommit(
            command,
            workspaceDirectory,
            implementationBranch,
            signal,
          ),
          readOptionalRemoteReviewBranchCommit(
            command,
            workspaceDirectory,
            implementationBranch,
            signal,
          ),
          listReviewPullRequests(
            command,
            workspaceDirectory,
            repositoryArgument(repository),
            implementationBranch,
            "all",
            signal,
          ),
        ]);
      if (localImplementation !== null || remoteImplementation !== null) {
        throw new ImplementationBranchError(
          `Implementation-ветка «${implementationBranch}» уже существует`,
        );
      }
      if (previousPullRequests.length > 0) {
        throw new ImplementationBranchError(
          `Для implementation-ветки «${implementationBranch}» уже существует pull request`,
        );
      }

      return pendingImplementationBranchSessionSchema.parse({
        changeId,
        changeBranch,
        implementationBranch,
        rootBaselineCommit,
        repository,
      });
    },

    async activate(workspaceDirectory, sessionInput, signal) {
      const session = pendingImplementationBranchSessionSchema.parse(sessionInput);
      await assertCleanReviewWorktree(command, workspaceDirectory, signal);
      const [currentBranch, localRoot, remoteRoot, localImplementation, remoteImplementation] =
        await Promise.all([
          readCurrentReviewBranch(command, workspaceDirectory, signal),
          readLocalReviewBranchCommit(
            command,
            workspaceDirectory,
            session.changeBranch,
            signal,
          ),
          readRemoteReviewBranchCommit(
            command,
            workspaceDirectory,
            session.changeBranch,
            signal,
          ),
          readLocalReviewBranchCommit(
            command,
            workspaceDirectory,
            session.implementationBranch,
            signal,
          ),
          readOptionalRemoteReviewBranchCommit(
            command,
            workspaceDirectory,
            session.implementationBranch,
            signal,
          ),
        ]);
      if (
        localRoot !== session.rootBaselineCommit ||
        remoteRoot !== session.rootBaselineCommit
      ) {
        throw new ImplementationBranchError(
          `Корневая ветка «${session.changeBranch}» изменилась после подготовки implementation`,
        );
      }
      if (remoteImplementation !== null) {
        throw new ImplementationBranchError(
          `Implementation-ветка «${session.implementationBranch}» неожиданно появилась в origin`,
        );
      }
      const repository = await resolveReviewRepository(command, workspaceDirectory, signal);
      if (
        repository.host !== session.repository.host ||
        repository.nameWithOwner.toLowerCase() !==
          session.repository.nameWithOwner.toLowerCase() ||
        repository.url !== session.repository.url
      ) {
        throw new ImplementationBranchError(
          "Git remote origin больше не соответствует сохранённому репозиторию",
        );
      }
      const pullRequests = await listReviewPullRequests(
        command,
        workspaceDirectory,
        repositoryArgument(repository),
        session.implementationBranch,
        "all",
        signal,
      );
      if (pullRequests.length > 0) {
        throw new ImplementationBranchError(
          `Для implementation-ветки «${session.implementationBranch}» неожиданно появился pull request`,
        );
      }

      if (currentBranch === session.changeBranch) {
        if (localImplementation !== null) {
          throw new ImplementationBranchError(
            "Implementation-ветка уже создана, но не является текущей",
          );
        }
        try {
          await command(
            "git",
            ["switch", "-c", session.implementationBranch, session.rootBaselineCommit],
            { cwd: workspaceDirectory, signal },
          );
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new ImplementationBranchError(
            `Не удалось создать implementation-ветку «${session.implementationBranch}»`,
          );
        }
      } else if (currentBranch !== session.implementationBranch) {
        throw new ImplementationBranchError(
          `Для восстановления требуется ветка «${session.changeBranch}» или «${session.implementationBranch}»`,
        );
      }

      const [activatedBranch, activatedHead] = await Promise.all([
        readCurrentReviewBranch(command, workspaceDirectory, signal),
        readReviewHeadCommit(command, workspaceDirectory, signal),
      ]);
      if (
        activatedBranch !== session.implementationBranch ||
        activatedHead !== session.rootBaselineCommit
      ) {
        throw new ImplementationBranchError(
          "Implementation-ветка создана не от сохранённого root baseline",
        );
      }
      return implementationRunSchema.parse({
        changeId: session.changeId,
        changeBranch: session.changeBranch,
        implementationBranch: session.implementationBranch,
        rootBaselineCommit: session.rootBaselineCommit,
        repository: session.repository,
        publication: { kind: "unpublished" },
        batch: { kind: "empty", baseCommit: session.rootBaselineCommit },
        lastDeliveryHead: null,
        processedFeedbackFingerprints: [],
      });
    },
  };
}
