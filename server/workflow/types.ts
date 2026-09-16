import type { GitBranchDecision, GitBranchProbe } from "../git-branch.ts";

export interface WorkflowState {
  readonly branch: Extract<GitBranchDecision, { kind: "non-main" }>["name"] | null;
}

export interface WorkflowServices {
  readonly gitBranch: GitBranchProbe;
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
