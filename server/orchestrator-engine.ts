import type { ControlCommand } from "../shared/orchestrator.ts";
import type { OrchestratorWorkspaceDisplay } from "../shared/orchestrator-notifications.ts";
import type { AgentProfileReader } from "./agent-profiles.ts";
import type { ChangeArtifactCreationService } from "./change-artifact-creation.ts";
import type { ChangeSelectionService } from "./change-selection.ts";
import type { ChangePublicationService } from "./change-publication.ts";
import type { ChangeReviewService } from "./change-review.ts";
import type { ChangeFindingResolutionService } from "./change-finding-resolution.ts";
import type { ImplementationFindingResolutionService } from "./implementation-finding-resolution.ts";
import type { ChangeTaskExecutionService } from "./change-task-execution.ts";
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
  readonly changeReview: ChangeReviewService;
  readonly changeFindingResolution: ChangeFindingResolutionService;
  readonly implementationFindingResolution: ImplementationFindingResolutionService;
  readonly changeTaskExecution: ChangeTaskExecutionService;
}

export interface OrchestratorEngine {
  initialize(workspaceId: string, context: OrchestratorEngineContext): void;
  command(workspaceId: string, command: ControlCommand): void;
  dispose(): void | Promise<void>;
}
