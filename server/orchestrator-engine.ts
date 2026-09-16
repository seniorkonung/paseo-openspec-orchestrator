import type { ControlCommand } from "../shared/orchestrator.ts";

export interface OrchestratorEngineContext {
  readonly workspaceDirectory: string;
  readonly projectName: string | null;
  readonly workspaceName: string | null;
}

export interface OrchestratorEngine {
  initialize(workspaceId: string, context: OrchestratorEngineContext): void;
  command(workspaceId: string, command: ControlCommand): void;
  dispose(): void;
}
