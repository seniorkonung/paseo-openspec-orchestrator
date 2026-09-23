import { z } from "zod";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { changeBranchFor, changeBranchSchema } from "./change-branch.ts";
import {
  implementationRepositorySchema,
  implementationRunSchema,
  type ImplementationRun,
} from "./implementation-run-model.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  assertCleanReviewWorktree,
  readCurrentReviewBranch,
  readRemoteReviewBranchCommit,
  readReviewHeadCommit,
  resolveReviewRepository,
} from "./review-publication-gateway.ts";
import { createRootPullRequestService } from "./root-pull-request.ts";

export const pendingImplementationBranchSessionSchema = z.object({
  changeId: openSpecChangeIdSchema,
  changeBranch: changeBranchSchema,
  implementationBranch: changeBranchSchema,
  phaseNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  runNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  rootBaselineCommit: commitHashSchema,
  repository: implementationRepositorySchema,
}).strict().superRefine((session, context) => {
  if (session.changeBranch !== changeBranchFor(session.changeId) ||
      session.implementationBranch !== session.changeBranch) {
    context.addIssue({ code: "custom", path: ["implementationBranch"], message: "Реализация должна идти в корневой ветке change" });
  }
});

export type PendingImplementationBranchSession = z.infer<typeof pendingImplementationBranchSessionSchema>;
export interface ImplementationBranchService {
  prepare(workspaceDirectory: string, changeId: string, changeBranch: string, phaseNumber: number, runNumber: number, signal?: AbortSignal): Promise<PendingImplementationBranchSession>;
  prepare(workspaceDirectory: string, changeId: string, changeBranch: string, signal?: AbortSignal): Promise<PendingImplementationBranchSession>;
  activate(workspaceDirectory: string, session: PendingImplementationBranchSession, signal?: AbortSignal): Promise<ImplementationRun>;
}
export interface ImplementationBranchServiceOptions { readonly command?: BoundedCommandRunner }
export class ImplementationBranchError extends Error {
  constructor(message: string) { super(message); this.name = "ImplementationBranchError"; }
}

export function createImplementationBranchService(options: ImplementationBranchServiceOptions = {}): ImplementationBranchService {
  const command = options.command ?? runBoundedCommand;
  const rootPullRequest = createRootPullRequestService({ command });
  const assertRoot = async (directory: string, changeId: string, branch: string, expected: string | null, signal?: AbortSignal) => {
    await assertCleanReviewWorktree(command, directory, signal);
    const [current, local, remote, repository] = await Promise.all([
      readCurrentReviewBranch(command, directory, signal),
      readReviewHeadCommit(command, directory, signal),
      readRemoteReviewBranchCommit(command, directory, branch, signal),
      resolveReviewRepository(command, directory, signal),
    ]);
    if (current !== branch || local !== remote || (expected !== null && local !== expected)) {
      throw new ImplementationBranchError("Корневая ветка изменилась перед реализацией");
    }
    const pr = await rootPullRequest.inspect(directory, changeId, branch, null, signal);
    if (pr.kind !== "open" || !pr.isDraft) {
      throw new ImplementationBranchError("Для реализации требуется открытый Draft корневой PR");
    }
    return { local, repository };
  };
  return {
    async prepare(workspaceDirectory, changeIdInput, changeBranchInput, phaseOrSignal?: number | AbortSignal, runNumberInput?: number, maybeSignal?: AbortSignal) {
      const phaseNumber = typeof phaseOrSignal === "number" ? phaseOrSignal : 1;
      const runNumber = typeof phaseOrSignal === "number" ? runNumberInput : 1;
      const signal = phaseOrSignal instanceof AbortSignal ? phaseOrSignal : maybeSignal;
      const changeId = openSpecChangeIdSchema.parse(changeIdInput);
      const changeBranch = changeBranchSchema.parse(changeBranchInput);
      if (changeBranch !== changeBranchFor(changeId)) throw new ImplementationBranchError("Корневая ветка не соответствует change");
      const { local, repository } = await assertRoot(workspaceDirectory, changeId, changeBranch, null, signal);
      return pendingImplementationBranchSessionSchema.parse({
        changeId, changeBranch, implementationBranch: changeBranch,
        phaseNumber, runNumber, rootBaselineCommit: local, repository,
      });
    },
    async activate(workspaceDirectory, sessionInput, signal) {
      const session = pendingImplementationBranchSessionSchema.parse(sessionInput);
      const { repository } = await assertRoot(workspaceDirectory, session.changeId, session.changeBranch, session.rootBaselineCommit, signal);
      if (repository.host !== session.repository.host ||
          repository.nameWithOwner.toLowerCase() !== session.repository.nameWithOwner.toLowerCase() ||
          repository.url !== session.repository.url) {
        throw new ImplementationBranchError("Репозиторий origin изменился");
      }
      return implementationRunSchema.parse({
        changeId: session.changeId,
        changeBranch: session.changeBranch,
        implementationBranch: session.changeBranch,
        phaseNumber: session.phaseNumber,
        runNumber: session.runNumber,
        rootBaselineCommit: session.rootBaselineCommit,
        repository: session.repository,
        publication: { kind: "unreviewed" },
        batch: { kind: "empty", baseCommit: session.rootBaselineCommit },
      });
    },
  };
}
