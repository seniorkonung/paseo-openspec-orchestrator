import type { ControlCommand } from "../shared/orchestrator.ts";
import type { OrchestratorWorkspaceDisplay } from "../shared/orchestrator-notifications.ts";
import type { WorkflowDefinition } from "./workflow/types.ts";

export interface OrchestratorEngineContext {
  readonly workspaceDisplay: OrchestratorWorkspaceDisplay;
  readonly refreshWorkspaceDisplay: () => Promise<OrchestratorWorkspaceDisplay>;
  readonly workflow: WorkflowDefinition;
}

export interface OrchestratorEngine {
  initialize(workspaceId: string, context: OrchestratorEngineContext): void;
  command(workspaceId: string, command: ControlCommand): void;
  dispose(): void | Promise<void>;
}
