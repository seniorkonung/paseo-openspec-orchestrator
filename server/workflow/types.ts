import type { GitBranchDecision, GitBranchProbe } from "../git-branch.ts";
import type { GitWorktreeProbe } from "../git-worktree.ts";
import { z } from "zod";

export interface WorkflowState {
  readonly branch: Extract<GitBranchDecision, { kind: "non-main" }>["name"] | null;
}

export interface WorkflowServices {
  readonly gitBranch: GitBranchProbe;
  readonly gitWorktree: GitWorktreeProbe;
}

export type WorkflowStepId = string;

/**
 * Схема состояния workflow на границе хранения.
 * При добавлении нового поля его нужно добавить и сюда: это не позволит
 * случайно записать в checkpoint значение, которое нельзя восстановить из JSON.
 */
export const workflowStateSchema = z
  .object({
    branch: z.string().trim().max(512).nullable(),
  })
  .strict();

export const workflowCheckpointSchema = z
  .object({
    version: z.literal(1),
    nextStepId: z.string().trim().min(1).max(128),
    state: workflowStateSchema,
  })
  .strict();

export type WorkflowCheckpoint = z.infer<typeof workflowCheckpointSchema>;

export interface WorkflowStepContext {
  readonly workspaceDirectory: string;
  readonly signal: AbortSignal;
  readonly state: Readonly<WorkflowState>;
  readonly services: WorkflowServices;
}

export type WorkflowStepResult =
  | {
      kind: "continue";
      next: WorkflowStepId;
      state?: Partial<WorkflowState>;
      summary?: string;
    }
  | {
      kind: "complete";
      state?: Partial<WorkflowState>;
      summary?: string;
    }
  | {
      kind: "halt";
      state?: Partial<WorkflowState>;
      summary: string;
      message: string;
    };

export type WorkflowStepFunction = (
  context: WorkflowStepContext,
) => Promise<WorkflowStepResult>;

export interface WorkflowStepDefinition {
  readonly id: WorkflowStepId;
  readonly label: string;
  readonly run: WorkflowStepFunction;
}

export function createInitialWorkflowState(): WorkflowState {
  return { branch: null };
}
