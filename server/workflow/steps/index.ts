import type { AgentProfileReader } from "../../agent-profiles.ts";
import type { ChangeArtifactCreationService } from "../../change-artifact-creation.ts";
import type { ChangeFindingResolutionService } from "../../change-finding-resolution.ts";
import type { ChangePublicationService } from "../../change-publication.ts";
import type { ChangeReviewService } from "../../change-review.ts";
import type { ChangeInitializationService } from "../../change-initialization.ts";
import type { ChangeTaskExecutionService } from "../../change-task-execution.ts";
import type { GitBranchProbe } from "../../git-branch.ts";
import type { GitWorktreeProbe } from "../../git-worktree.ts";
import type { ImplementationFindingResolutionService } from "../../implementation-finding-resolution.ts";
import type { MiseToolchainProbe } from "../../mise-toolchain.ts";
import type { OpenSpecChangeVerifier } from "../../openspec-change.ts";
import type { PlanningBranchService } from "../../planning-branch.ts";
import type { ImplementationBranchService } from "../../implementation-branch.ts";
import type { ImplementationReviewService } from "../../implementation-review.ts";
import type { ImplementationRunVerifier } from "../../implementation-run-verification.ts";
import type { PhaseWorkService } from "../../phase-work.ts";
import type { PhaseTaskPlanningService } from "../../phase-task-planning.ts";
import type { RootPullRequestService } from "../../root-pull-request.ts";
import type { WorkflowDefinition } from "../types.ts";
import { createCheckAgentProfilesStep } from "./check-agent-profiles.ts";
import { createCheckGitBranchStep } from "./check-git-branch.ts";
import { createCheckGitWorktreeStep } from "./check-git-worktree.ts";
import { createCheckMiseToolchainStep } from "./check-mise-toolchain.ts";
import { createChangeArtifactsStep } from "./create-change-artifacts.ts";
import { createExecuteChangeTasksStep } from "./execute-change-tasks.ts";
import { createPublishChangeStep } from "./publish-change.ts";
import { createResolveImplementationReviewFindingsStep } from "./resolve-implementation-review-findings.ts";
import { createResolveReviewFindingsStep } from "./resolve-review-findings.ts";
import { createReviewChangeStep } from "./review-change.ts";
import { createInitializeChangeStep } from "./initialize-change.ts";
import { createPreparePlanningBranchStep } from "./prepare-planning-branch.ts";
import { createInspectChangeStep } from "./inspect-change.ts";
import { createPrepareImplementationBranchStep } from "./prepare-implementation-branch.ts";
import { createReviewImplementationStep } from "./review-implementation.ts";
import { createInspectPhaseWorkStep } from "./inspect-phase-work.ts";
import { createPreparePhasePlanningBranchStep } from "./prepare-phase-planning-branch.ts";
import { createPlanPhaseTasksStep } from "./plan-phase-tasks.ts";
import { createValidatePhasePlanningStep } from "./validate-phase-planning.ts";

/**
 * Все конкретные зависимости стандартного OpenSpec workflow.
 *
 * Это контракт сборки, а не локатор сервисов: он существует только в этой
 * точке. Каждый шаг получает из него свой меньший контракт, определённый
 * потребностями шага.
 */
export interface OpenSpecWorkflowDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly gitBranch: GitBranchProbe;
  readonly gitWorktree: GitWorktreeProbe;
  readonly miseToolchain: MiseToolchainProbe;
  readonly changeInitialization: ChangeInitializationService;
  readonly planningBranch: PlanningBranchService;
  readonly implementationBranch: ImplementationBranchService;
  readonly implementationReview: ImplementationReviewService;
  readonly implementationRunVerification: ImplementationRunVerifier;
  readonly verifyChange: OpenSpecChangeVerifier;
  readonly changeArtifacts: ChangeArtifactCreationService;
  readonly changePublication: ChangePublicationService;
  readonly changeReview: ChangeReviewService;
  readonly changeFindingResolution: ChangeFindingResolutionService;
  readonly implementationFindingResolution: ImplementationFindingResolutionService;
  readonly changeTaskExecution: ChangeTaskExecutionService;
  readonly phaseWork: PhaseWorkService;
  readonly phaseTaskPlanning: PhaseTaskPlanningService;
  readonly rootPullRequest: RootPullRequestService;
}

/**
 * Связывает конкретные возможности со сценариями один раз, до запуска движка.
 * После этой границы движок видит только исполняемый WorkflowDefinition.
 */
export function createOpenSpecWorkflow(
  dependencies: OpenSpecWorkflowDependencies,
): WorkflowDefinition {
  return {
    startStepId: "check-agent-profiles",
    steps: Object.freeze([
      createCheckAgentProfilesStep({
        readAgentProfiles: dependencies.readAgentProfiles,
      }),
      createCheckGitBranchStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        inspectBranch: dependencies.gitBranch,
      }),
      createCheckGitWorktreeStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        inspectWorktree: dependencies.gitWorktree,
      }),
      createCheckMiseToolchainStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        inspectToolchain: dependencies.miseToolchain,
      }),
      createInitializeChangeStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        changeInitialization: dependencies.changeInitialization,
      }),
      createPreparePlanningBranchStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        planningBranch: dependencies.planningBranch,
      }),
      createInspectChangeStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        verifyChange: dependencies.verifyChange,
        changeArtifacts: dependencies.changeArtifacts,
      }),
      createChangeArtifactsStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        readAgentProfiles: dependencies.readAgentProfiles,
        changeArtifacts: dependencies.changeArtifacts,
      }),
      createPublishChangeStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        readAgentProfiles: dependencies.readAgentProfiles,
        inspectBranch: dependencies.gitBranch,
        inspectWorktree: dependencies.gitWorktree,
        verifyChange: dependencies.verifyChange,
        changeArtifacts: dependencies.changeArtifacts,
        changePublication: dependencies.changePublication,
      }),
      createReviewChangeStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        readAgentProfiles: dependencies.readAgentProfiles,
        changeReview: dependencies.changeReview,
      }),
      createResolveReviewFindingsStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        readAgentProfiles: dependencies.readAgentProfiles,
        findingResolution: dependencies.changeFindingResolution,
        implementationRunVerification: dependencies.implementationRunVerification,
      }),
      createInspectPhaseWorkStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        phaseWork: dependencies.phaseWork,
        rootPullRequest: dependencies.rootPullRequest,
      }),
      createPreparePhasePlanningBranchStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        planningBranch: dependencies.planningBranch,
      }),
      createPlanPhaseTasksStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        readAgentProfiles: dependencies.readAgentProfiles,
        phaseTaskPlanning: dependencies.phaseTaskPlanning,
      }),
      createValidatePhasePlanningStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        phaseWork: dependencies.phaseWork,
      }),
      createPrepareImplementationBranchStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        implementationBranch: dependencies.implementationBranch,
      }),
      createExecuteChangeTasksStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        readAgentProfiles: dependencies.readAgentProfiles,
        taskExecution: dependencies.changeTaskExecution,
      }),
      createReviewImplementationStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        readAgentProfiles: dependencies.readAgentProfiles,
        implementationReview: dependencies.implementationReview,
      }),
      createResolveImplementationReviewFindingsStep({
        workspaceDirectory: dependencies.workspaceDirectory,
        readAgentProfiles: dependencies.readAgentProfiles,
        findingResolution: dependencies.implementationFindingResolution,
        implementationRunVerification: dependencies.implementationRunVerification,
        phaseWork: dependencies.phaseWork,
      }),
    ]),
  };
}
