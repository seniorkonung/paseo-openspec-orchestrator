import type { ControlCommand } from "../shared/orchestrator.ts";

export interface OrchestratorEngine {
  initialize(workspaceId: string): void;
  command(workspaceId: string, command: ControlCommand): void;
  dispose(): void;
}
