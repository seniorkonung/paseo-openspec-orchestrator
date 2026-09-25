import { describeRequiredAgentProfileProblem, resolveRequiredAgentProfile, type AgentProfileReader } from "../../agent-profiles.ts";
import type { ChangeArchiveService } from "../../change-archive.ts";
import { ChangeArchiveError } from "../../change-archive-model.ts";
import type { ChangeFindingResolutionService } from "../../change-finding-resolution.ts";
import type { ImplementationFindingResolutionService } from "../../implementation-finding-resolution.ts";
import { PhaseWorkError, type PhaseWorkService } from "../../phase-work.ts";
import type { WorkflowStepContext, WorkflowStepDefinition, WorkflowStepResult } from "../types.ts";

export interface ArchiveChangeDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly archive: ChangeArchiveService;
  readonly phaseWork: Pick<PhaseWorkService, "inspect">;
  readonly changeFindings: Pick<ChangeFindingResolutionService, "plan">;
  readonly implementationFindings: Pick<ImplementationFindingResolutionService, "plan">;
}

async function archiveChangeStep(dependencies: ArchiveChangeDependencies, context: WorkflowStepContext): Promise<WorkflowStepResult> {
  const { change, changeBranch, activeBranch, rootPullRequest, phaseProgress } = context.state;
  if (!change || !changeBranch || activeBranch !== changeBranch || !rootPullRequest || !phaseProgress ||
      context.state.phaseTarget || context.state.implementationRun || context.state.planningRun || context.state.archivedChange) {
    return { kind: "halt", summary: "Недостаточно данных для архивации", message: "Архивация требует завершённого change и корневого PR" };
  }
  let session = context.state.pendingArchiveSession;
  if (!session) {
    try {
      const decision = await dependencies.phaseWork.inspect(dependencies.workspaceDirectory, change.id, phaseProgress, context.signal);
      if (decision.kind !== "change-complete") throw new ChangeArchiveError("В change появилась незавершённая работа");
      if (decision.progress.phases.length === 0 || decision.progress.tasks.length === 0) {
        throw new ChangeArchiveError("Для архивации нужны распланированные и выполненные задачи");
      }
      const [review, implementationReview] = await Promise.all([
        dependencies.changeFindings.plan(dependencies.workspaceDirectory, change.id, changeBranch, context.signal),
        dependencies.implementationFindings.plan(dependencies.workspaceDirectory, change.id, changeBranch, context.signal),
      ]);
      if (review.kind !== "no-findings" || implementationReview.kind !== "no-findings") {
        throw new ChangeArchiveError("Перед архивацией нужно устранить все findings review");
      }
      session = await dependencies.archive.plan(dependencies.workspaceDirectory, change.id, rootPullRequest, context.signal);
      await context.checkpointState({ ...context.state, phaseProgress: decision.progress, pendingArchiveSession: session });
    } catch (error) { return archiveFailure(context, error, "Не удалось подготовить архивацию change"); }
  }
  let profiles;
  try { profiles = await dependencies.readAgentProfiles(); }
  catch (error) { return archiveFailure(context, error, "Не удалось перечитать профиль High перед архивацией"); }
  const resolution = resolveRequiredAgentProfile(profiles, "High");
  if (resolution.kind === "invalid") {
    const summary = describeRequiredAgentProfileProblem("High", resolution);
    return { kind: "halt", summary, message: `${summary}; исправьте Agent profiles в Paseo и нажмите «Повторить»` };
  }
  try {
    const archived = await dependencies.archive.run({
      workspaceDirectory: dependencies.workspaceDirectory,
      profile: resolution.profile,
      session,
      signal: context.signal,
      onAgentCreated: (agentId) => context.updateActionLinks([{ kind: "agent", agentId, label: `Архивация change ${change.id}` }]),
    });
    return {
      kind: "continue",
      next: "await-root-merge",
      state: { pendingArchiveSession: null, archivedChange: archived },
      summary: `Change ${change.id} архивирован коммитом ${archived.commit}`,
    };
  } catch (error) { return archiveFailure(context, error, "Не удалось завершить архивацию change"); }
}

function archiveFailure(context: WorkflowStepContext, error: unknown, fallback: string): WorkflowStepResult {
  if (context.signal.aborted) throw error;
  console.error("[OpenSpec] Ошибка архивации change", { code: error instanceof Error ? error.name : "unknown" });
  const summary = error instanceof ChangeArchiveError || error instanceof PhaseWorkError ? error.message : fallback;
  return { kind: "halt", summary, message: `${summary}; исправьте состояние и нажмите «Повторить»` };
}

export function createArchiveChangeStep(dependencies: ArchiveChangeDependencies): WorkflowStepDefinition {
  return { id: "archive-change", label: "Архивирую завершённый OpenSpec change", run: (context) => archiveChangeStep(dependencies, context) };
}
