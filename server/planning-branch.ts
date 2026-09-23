import { z } from "zod";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { changeBranchFor, changeBranchSchema, type PlanningBranch } from "./change-branch.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  assertCleanReviewWorktree,
  readCurrentReviewBranch,
  readRemoteReviewBranchCommit,
  readReviewHeadCommit,
} from "./review-publication-gateway.ts";
import { createRootPullRequestService } from "./root-pull-request.ts";

export const pendingPlanningBranchSessionSchema = z.object({
  changeId: openSpecChangeIdSchema,
  changeBranch: changeBranchSchema,
  planningBranch: changeBranchSchema,
  baselineCommit: commitHashSchema,
}).strict().superRefine((session, context) => {
  if (session.changeBranch !== changeBranchFor(session.changeId) ||
      session.planningBranch !== session.changeBranch) {
    context.addIssue({ code: "custom", path: ["planningBranch"], message: "Planning должен идти в корневой ветке change" });
  }
});

export type PendingPlanningBranchSession = z.infer<typeof pendingPlanningBranchSessionSchema>;
export type PlanningBranchTarget =
  | { readonly kind: "initial" }
  | { readonly kind: "phase"; readonly phaseNumber: number };

export interface PlanningBranchService {
  prepare(workspaceDirectory: string, changeId: string, changeBranch: string, signal?: AbortSignal): Promise<PendingPlanningBranchSession>;
  prepare(workspaceDirectory: string, changeId: string, changeBranch: string, target: PlanningBranchTarget, signal?: AbortSignal): Promise<PendingPlanningBranchSession>;
  activate(workspaceDirectory: string, session: PendingPlanningBranchSession, signal?: AbortSignal): Promise<PlanningBranch>;
}

export interface PlanningBranchServiceOptions { readonly command?: BoundedCommandRunner }
export class PlanningBranchError extends Error {
  constructor(message: string) { super(message); this.name = "PlanningBranchError"; }
}

export function createPlanningBranchService(options: PlanningBranchServiceOptions = {}): PlanningBranchService {
  const command = options.command ?? runBoundedCommand;
  const rootPullRequest = createRootPullRequestService({ command });
  const assertBaseline = async (workspaceDirectory: string, changeId: string, branch: string, expected: string | null, signal?: AbortSignal) => {
    await assertCleanReviewWorktree(command, workspaceDirectory, signal);
    const [current, local, remote] = await Promise.all([
      readCurrentReviewBranch(command, workspaceDirectory, signal),
      readReviewHeadCommit(command, workspaceDirectory, signal),
      readRemoteReviewBranchCommit(command, workspaceDirectory, branch, signal),
    ]);
    if (current !== branch || local !== remote || (expected !== null && local !== expected)) {
      throw new PlanningBranchError("Корневая ветка изменилась перед planning");
    }
    let pr = await rootPullRequest.inspect(workspaceDirectory, changeId, branch, null, signal);
    if (pr.kind !== "open") {
      throw new PlanningBranchError("Для planning требуется открытый корневой PR");
    }
    if (!pr.isDraft) {
      pr = await rootPullRequest.makeDraft(workspaceDirectory, pr, signal);
      if (pr.kind !== "open" || !pr.isDraft) {
        throw new PlanningBranchError("Корневой PR не перешёл в Draft перед planning");
      }
    }
    return local;
  };
  return {
    async prepare(workspaceDirectory, changeIdInput, changeBranchInput, targetOrSignal?: PlanningBranchTarget | AbortSignal, maybeSignal?: AbortSignal) {
      const signal = targetOrSignal instanceof AbortSignal ? targetOrSignal : maybeSignal;
      const target = targetOrSignal instanceof AbortSignal || targetOrSignal === undefined ? { kind: "initial" } as const : targetOrSignal;
      if (target.kind === "phase" && (!Number.isSafeInteger(target.phaseNumber) || target.phaseNumber < 1)) {
        throw new PlanningBranchError("Номер фазы должен быть положительным целым");
      }
      const changeId = openSpecChangeIdSchema.parse(changeIdInput);
      const changeBranch = changeBranchSchema.parse(changeBranchInput);
      if (changeBranch !== changeBranchFor(changeId)) throw new PlanningBranchError("Корневая ветка не соответствует change");
      const baselineCommit = await assertBaseline(workspaceDirectory, changeId, changeBranch, null, signal);
      return pendingPlanningBranchSessionSchema.parse({ changeId, changeBranch, planningBranch: changeBranch, baselineCommit });
    },
    async activate(workspaceDirectory, sessionInput, signal) {
      const session = pendingPlanningBranchSessionSchema.parse(sessionInput);
      await assertBaseline(workspaceDirectory, session.changeId, session.changeBranch, session.baselineCommit, signal);
      return session.changeBranch;
    },
  };
}
