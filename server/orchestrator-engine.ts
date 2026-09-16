import type { ControlCommand } from "../shared/orchestrator.ts";

export interface OrchestratorEngineContext {
  readonly workspaceDirectory: string;
}

export interface OrchestratorEngine {
  initialize(workspaceId: string, context: OrchestratorEngineContext): void;
  command(workspaceId: string, command: ControlCommand): void;
  dispose(): void;
}
