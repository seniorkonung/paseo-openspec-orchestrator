import type { ControlCommand } from "../shared/orchestrator.ts";
import type { OrchestratorWorkspaceDisplay } from "../shared/orchestrator-notifications.ts";
import type { AgentProfileReader } from "./agent-profiles.ts";

export interface OrchestratorEngineContext {
  readonly workspaceDirectory: string;
  readonly workspaceDisplay: OrchestratorWorkspaceDisplay;
  readonly refreshWorkspaceDisplay: () => Promise<OrchestratorWorkspaceDisplay>;
  readonly readAgentProfiles: AgentProfileReader;
}

export interface OrchestratorEngine {
  initialize(workspaceId: string, context: OrchestratorEngineContext): void;
  command(workspaceId: string, command: ControlCommand): void;
  dispose(): void;
}
