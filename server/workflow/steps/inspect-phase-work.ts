import { PhaseWorkError, type PhaseWorkService } from "../../phase-work.ts";
import {
  RootPullRequestError,
  type RootPullRequestInspection,
  type RootPullRequestService,
} from "../../root-pull-request.ts";
import type {
  WorkflowState,
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export interface InspectPhaseWorkDependencies {
  readonly workspaceDirectory: string;
  readonly phaseWork: PhaseWorkService;
  readonly rootPullRequest: RootPullRequestService;
}

async function inspectPhaseWorkStep(
  dependencies: InspectPhaseWorkDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { change, changeBranch, activeBranch } = context.state;
  if (!change || !changeBranch || activeBranch !== changeBranch) {
    return {
      kind: "halt",
      summary: "Недостаточно данных для проверки фаз",
      message: "Перед проверкой фаз должна быть активна корневая change-ветка",
    };
  }
  try {
    await dependencies.rootPullRequest.synchronize(
      dependencies.workspaceDirectory,
      change.id,
      changeBranch,
      context.signal,
    );
    let pullRequest = await dependencies.rootPullRequest.inspect(
      dependencies.workspaceDirectory,
      change.id,
      changeBranch,
      context.state.rootPullRequest,
      context.signal,
    );
    const decision = await dependencies.phaseWork.inspect(
      dependencies.workspaceDirectory,
      change.id,
      context.state.phaseProgress,
      context.signal,
    );

    if (decision.kind !== "change-complete") {
      assertRootOpenWithPendingWork(pullRequest);
      if (!pullRequest.isDraft) {
        pullRequest = await dependencies.rootPullRequest.makeDraft(
          dependencies.workspaceDirectory,
          pullRequest,
          context.signal,
        );
        assertRootOpenWithPendingWork(pullRequest);
        if (!pullRequest.isDraft) {
          throw new RootPullRequestError("Корневой pull request остался Ready при незавершённой работе");
        }
      }
      if (decision.kind === "planning-required") {
        return {
          kind: "continue",
          next: "prepare-phase-planning-branch",
          state: {
            phaseProgress: decision.progress,
            rootPullRequest: pullRequest.identity,
            phaseTarget: { kind: "planning", phaseNumber: decision.phaseNumber },
            implementationRun: null,
            planningRun: null,
          },
          summary: `Phase ${decision.phaseNumber} требует планирования задач`,
        };
      }
      return {
        kind: "continue",
        next: "prepare-implementation-branch",
        state: {
          phaseProgress: {
            ...decision.progress,
            nextImplementationRun: decision.runNumber + 1,
          },
          rootPullRequest: pullRequest.identity,
          phaseTarget: {
            kind: "implementation",
            phaseNumber: decision.phaseNumber,
            runNumber: decision.runNumber,
          },
          implementationRun: null,
          planningRun: null,
        },
        summary: `Phase ${decision.phaseNumber} готова к implementation run ${decision.runNumber}`,
      };
    }

    if (pullRequest.kind === "closed") {
      throw new RootPullRequestError("Корневой pull request закрыт без merge");
    }
    if (pullRequest.kind === "merged") {
      throw new RootPullRequestError("Корневой PR уже слит без архивного коммита; включить архив в этот PR невозможно");
    }
    if (!pullRequest.isDraft) {
      const drafted = await dependencies.rootPullRequest.makeDraft(
        dependencies.workspaceDirectory,
        pullRequest,
        context.signal,
      );
      if (drafted.kind !== "open" || !drafted.isDraft) throw new RootPullRequestError("Корневой PR изменился до архивации");
      pullRequest = drafted;
    }

    // Перед агентской архивацией повторно проверяем задачи и PR после Draft.
    await dependencies.rootPullRequest.synchronize(
      dependencies.workspaceDirectory,
      change.id,
      changeBranch,
      context.signal,
    );
    const racedDecision = await dependencies.phaseWork.inspect(
      dependencies.workspaceDirectory,
      change.id,
      decision.progress,
      context.signal,
    );
    const racedPullRequest = await dependencies.rootPullRequest.inspect(
      dependencies.workspaceDirectory,
      change.id,
      changeBranch,
      pullRequest.identity,
      context.signal,
    );
    if (racedDecision.kind !== "change-complete") {
      if (racedPullRequest.kind !== "open") {
        throw new RootPullRequestError("Корневой PR слит при появившейся работе");
      }
      if (!racedPullRequest.isDraft) {
        const drafted = await dependencies.rootPullRequest.makeDraft(
          dependencies.workspaceDirectory,
          racedPullRequest,
          context.signal,
        );
        assertRootOpenWithPendingWork(drafted);
        if (!drafted.isDraft) {
          throw new RootPullRequestError("Корневой pull request остался Ready при появившейся работе");
        }
      }
      return routeRacedWork(racedDecision, racedPullRequest.identity);
    }
    if (racedPullRequest.kind === "closed") {
      throw new RootPullRequestError("Корневой pull request закрыт без merge");
    }
    if (racedPullRequest.kind === "merged") {
      throw new RootPullRequestError("Корневой PR слит до архивного коммита");
    }
    if (!racedPullRequest.isDraft) throw new RootPullRequestError("Корневой PR должен оставаться Draft до архивации");
    return {
      kind: "continue",
      next: "archive-change",
      state: {
        phaseProgress: racedDecision.progress,
        rootPullRequest: racedPullRequest.identity,
        phaseTarget: null,
        implementationRun: null,
        planningRun: null,
      },
      summary: `Все фазы change ${change.id} выполнены; начинаю архивацию`,
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary = error instanceof PhaseWorkError || error instanceof RootPullRequestError
      ? error.message
      : "Не удалось проверить пофазное состояние change";
    return {
      kind: "halt",
      summary,
      message: `${summary}; исправьте состояние и нажмите «Повторить»`,
    };
  }
}

function assertRootOpenWithPendingWork(
  inspection: RootPullRequestInspection,
): asserts inspection is Extract<RootPullRequestInspection, { kind: "open" }> {
  if (inspection.kind === "merged") {
    throw new RootPullRequestError("Корневой pull request слит при оставшейся работе");
  }
  if (inspection.kind === "closed") {
    throw new RootPullRequestError("Корневой pull request закрыт без merge");
  }
}

function routeRacedWork(
  decision: Exclude<Awaited<ReturnType<PhaseWorkService["inspect"]>>, { kind: "change-complete" }>,
  rootPullRequest: NonNullable<WorkflowState["rootPullRequest"]>,
): WorkflowStepResult {
  if (decision.kind === "planning-required") {
    return {
      kind: "continue",
      next: "prepare-phase-planning-branch",
      state: {
        phaseProgress: decision.progress,
        rootPullRequest,
        phaseTarget: { kind: "planning", phaseNumber: decision.phaseNumber },
        implementationRun: null,
        planningRun: null,
      },
      summary: `После Ready обнаружена новая Phase ${decision.phaseNumber}`,
    };
  }
  return {
    kind: "continue",
    next: "prepare-implementation-branch",
    state: {
      phaseProgress: { ...decision.progress, nextImplementationRun: decision.runNumber + 1 },
      rootPullRequest,
      phaseTarget: {
        kind: "implementation",
        phaseNumber: decision.phaseNumber,
        runNumber: decision.runNumber,
      },
      implementationRun: null,
      planningRun: null,
    },
    summary: `После Ready обнаружена новая задача Phase ${decision.phaseNumber}`,
  };
}

export function createInspectPhaseWorkStep(
  dependencies: InspectPhaseWorkDependencies,
): WorkflowStepDefinition {
  return {
    id: "inspect-phase-work",
    label: "Проверяю фазы, задачи и корневой pull request",
    run: (context) => inspectPhaseWorkStep(dependencies, context),
  };
}
