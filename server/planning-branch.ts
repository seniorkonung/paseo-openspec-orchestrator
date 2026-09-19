import { z } from "zod";
import {
  assertPlanningBranchFor,
  changeBranchFor,
  changeBranchSchema,
  initialPlanningBranchFor,
  phasePlanningBranchFor,
  planningBranchSchema,
  type PlanningBranch,
} from "./change-branch.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-command.ts";
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

export const pendingPlanningBranchSessionSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    changeBranch: changeBranchSchema,
    planningBranch: planningBranchSchema,
    baselineCommit: commitHashSchema,
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
    try {
      assertPlanningBranchFor(session.planningBranch, session.changeId);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["planningBranch"],
        message: "Planning-ветка не соответствует change",
      });
    }
  });

export type PendingPlanningBranchSession = z.infer<
  typeof pendingPlanningBranchSessionSchema
>;

export interface PlanningBranchService {
  prepare(
    workspaceDirectory: string,
    changeId: string,
    changeBranch: string,
    signal?: AbortSignal,
  ): Promise<PendingPlanningBranchSession>;
  prepare(
    workspaceDirectory: string,
    changeId: string,
    changeBranch: string,
    target: PlanningBranchTarget,
    signal?: AbortSignal,
  ): Promise<PendingPlanningBranchSession>;
  activate(
    workspaceDirectory: string,
    session: PendingPlanningBranchSession,
    signal?: AbortSignal,
  ): Promise<PlanningBranch>;
}

export type PlanningBranchTarget =
  | { readonly kind: "initial" }
  | { readonly kind: "phase"; readonly phaseNumber: number };

export interface PlanningBranchServiceOptions {
  readonly command?: BoundedCommandRunner;
}

export class PlanningBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningBranchError";
  }
}

export function createPlanningBranchService(
  options: PlanningBranchServiceOptions = {},
): PlanningBranchService {
  const command = options.command ?? runBoundedCommand;

  return {
    async prepare(
      workspaceDirectory,
      changeIdInput,
      changeBranchInput,
      targetOrSignal?: PlanningBranchTarget | AbortSignal,
      maybeSignal?: AbortSignal,
    ) {
      const target = isAbortSignal(targetOrSignal) || targetOrSignal === undefined
        ? { kind: "initial" } as const
        : targetOrSignal;
      const signal = isAbortSignal(targetOrSignal) ? targetOrSignal : maybeSignal;
      const changeId = openSpecChangeIdSchema.parse(changeIdInput);
      const changeBranch = changeBranchSchema.parse(changeBranchInput);
      if (changeBranch !== changeBranchFor(changeId)) {
        throw new PlanningBranchError(
          "Корневая ветка не соответствует выбранному OpenSpec change",
        );
      }
      await assertCleanReviewWorktree(command, workspaceDirectory, signal);
      const [currentBranch, baselineCommit, remoteChangeHead, repository] =
        await Promise.all([
          readCurrentReviewBranch(command, workspaceDirectory, signal),
          readReviewHeadCommit(command, workspaceDirectory, signal),
          readRemoteReviewBranchCommit(
            command,
            workspaceDirectory,
            changeBranch,
            signal,
          ),
          resolveReviewRepository(command, workspaceDirectory, signal),
        ]);
      if (currentBranch !== changeBranch) {
        throw new PlanningBranchError(
          `Перед planning требуется корневая ветка «${changeBranch}»`,
        );
      }
      if (remoteChangeHead !== baselineCommit) {
        throw new PlanningBranchError(
          `Git remote origin не содержит текущий HEAD ветки «${changeBranch}»`,
        );
      }

      const planningBranch = target.kind === "initial"
        ? initialPlanningBranchFor(changeId)
        : phasePlanningBranchFor(changeId, target.phaseNumber);
      const [localPlanning, remotePlanning, previousPullRequests] = await Promise.all([
        readLocalReviewBranchCommit(command, workspaceDirectory, planningBranch, signal),
        readOptionalRemoteReviewBranchCommit(
          command,
          workspaceDirectory,
          planningBranch,
          signal,
        ),
        listReviewPullRequests(
          command,
          workspaceDirectory,
          repositoryArgument(repository),
          planningBranch,
          "all",
          signal,
        ),
      ]);
      if (localPlanning !== null || remotePlanning !== null) {
        throw new PlanningBranchError(
          `Planning-ветка «${planningBranch}» уже существует`,
        );
      }
      if (previousPullRequests.length > 0) {
        throw new PlanningBranchError(
          `Для planning-ветки «${planningBranch}» уже существует pull request`,
        );
      }
      return pendingPlanningBranchSessionSchema.parse({
        changeId,
        changeBranch,
        planningBranch,
        baselineCommit,
      });
    },

    async activate(workspaceDirectory, sessionInput, signal) {
      const session = pendingPlanningBranchSessionSchema.parse(sessionInput);
      await assertCleanReviewWorktree(command, workspaceDirectory, signal);
      const currentBranch = await readCurrentReviewBranch(
        command,
        workspaceDirectory,
        signal,
      );
      const [localChange, remoteChange, localPlanning, remotePlanning] =
        await Promise.all([
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
            session.planningBranch,
            signal,
          ),
          readOptionalRemoteReviewBranchCommit(
            command,
            workspaceDirectory,
            session.planningBranch,
            signal,
          ),
        ]);
      if (
        localChange !== session.baselineCommit ||
        remoteChange !== session.baselineCommit
      ) {
        throw new PlanningBranchError(
          `Корневая ветка «${session.changeBranch}» изменилась после подготовки planning`,
        );
      }
      if (remotePlanning !== null) {
        throw new PlanningBranchError(
          `Planning-ветка «${session.planningBranch}» неожиданно появилась в origin`,
        );
      }
      const repository = await resolveReviewRepository(
        command,
        workspaceDirectory,
        signal,
      );
      const previousPullRequests = await listReviewPullRequests(
        command,
        workspaceDirectory,
        repositoryArgument(repository),
        session.planningBranch,
        "all",
        signal,
      );
      if (previousPullRequests.length > 0) {
        throw new PlanningBranchError(
          `Для planning-ветки «${session.planningBranch}» неожиданно появился pull request`,
        );
      }

      if (currentBranch === session.changeBranch) {
        if (localPlanning !== null) {
          throw new PlanningBranchError(
            "Planning-ветка уже создана, но не является текущей",
          );
        }
        try {
          await command(
            "git",
            ["switch", "-c", session.planningBranch, session.baselineCommit],
            { cwd: workspaceDirectory, signal },
          );
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new PlanningBranchError(
            `Не удалось создать planning-ветку «${session.planningBranch}»`,
          );
        }
      } else if (currentBranch !== session.planningBranch) {
        throw new PlanningBranchError(
          `Для восстановления требуется ветка «${session.changeBranch}» или «${session.planningBranch}»`,
        );
      }

      const [activatedBranch, activatedHead] = await Promise.all([
        readCurrentReviewBranch(command, workspaceDirectory, signal),
        readReviewHeadCommit(command, workspaceDirectory, signal),
      ]);
      assertPlanningBranchFor(activatedBranch, session.changeId);
      if (activatedHead !== session.baselineCommit) {
        throw new PlanningBranchError(
          "Planning-ветка создана не от сохранённого baseline",
        );
      }
      return session.planningBranch;
    },
  };
}

function isAbortSignal(
  value: PlanningBranchTarget | AbortSignal | undefined,
): value is AbortSignal {
  return value instanceof AbortSignal;
}
