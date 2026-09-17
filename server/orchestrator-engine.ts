import type { ControlCommand } from "../shared/orchestrator.ts";
import type { OrchestratorWorkspaceDisplay } from "../shared/orchestrator-notifications.ts";
import type { AgentProfileReader } from "./agent-profiles.ts";
import type { ChangeArtifactCreationService } from "./change-artifact-creation.ts";
import type { ChangeSelectionService } from "./change-selection.ts";
import type { ChangePublicationService } from "./change-publication.ts";
import type { MiseToolchainProbe } from "./mise-toolchain.ts";

export interface OrchestratorEngineContext {
  readonly workspaceDirectory: string;
  readonly workspaceDisplay: OrchestratorWorkspaceDisplay;
  readonly refreshWorkspaceDisplay: () => Promise<OrchestratorWorkspaceDisplay>;
  readonly readAgentProfiles: AgentProfileReader;
  readonly miseToolchain: MiseToolchainProbe;
  readonly changeSelection: ChangeSelectionService;
  readonly changeArtifacts: ChangeArtifactCreationService;
  readonly changePublication: ChangePublicationService;
}

export interface OrchestratorEngine {
  initialize(workspaceId: string, context: OrchestratorEngineContext): void;
  command(workspaceId: string, command: ControlCommand): void;
  dispose(): void | Promise<void>;
}
