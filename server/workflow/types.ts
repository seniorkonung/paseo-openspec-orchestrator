import type { GitBranchDecision, GitBranchProbe } from "../git-branch.ts";
import type { GitWorktreeProbe } from "../git-worktree.ts";

export interface WorkflowState {
  readonly branch: Extract<GitBranchDecision, { kind: "non-main" }>["name"] | null;
}

export interface WorkflowServices {
  readonly gitBranch: GitBranchProbe;
  readonly gitWorktree: GitWorktreeProbe;
}

export interface WorkflowStepContext {
  readonly workspaceDirectory: string;
  readonly signal: AbortSignal;
  readonly state: Readonly<WorkflowState>;
  readonly services: WorkflowServices;
}

export type WorkflowStepResult =
  | {
      kind: "continue";
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
  readonly id: string;
  readonly label: string;
  readonly run: WorkflowStepFunction;
}

export function createInitialWorkflowState(): WorkflowState {
  return { branch: null };
}
