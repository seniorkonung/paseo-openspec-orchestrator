import {
  pendingFindingResolutionSessionSchema,
  type PendingFindingResolutionSession,
} from "../change-finding-resolution.ts";
import {
  pendingImplementationFindingResolutionSessionSchema,
  type PendingImplementationFindingResolutionSession,
} from "../implementation-finding-resolution.ts";
import {
  pendingReviewSessionSchema,
  type PendingReviewSession,
} from "../change-review.ts";
import {
  pendingArtifactSessionSchema,
  type PendingArtifactSession,
} from "../change-artifact-creation.ts";
import {
  pendingTaskExecutionSessionSchema,
  type PendingTaskExecutionSession,
} from "../change-task-execution.ts";
import {
  pendingChangeInitializationSessionSchema,
  type PendingChangeInitializationSession,
} from "../change-initialization.ts";
import {
  pendingPlanningBranchSessionSchema,
  type PendingPlanningBranchSession,
} from "../planning-branch.ts";
import {
  pendingPlanningMergeSessionSchema,
  type PendingPlanningMergeSession,
} from "../planning-merge.ts";
import {
  changeBranchSchema,
  initialPlanningBranchFor,
  implementationBranchSchema,
  implementationBranchForRun,
  phasePlanningBranchFor,
  planningBranchSchema,
  type ChangeBranch,
  type ImplementationBranch,
  type PlanningBranch,
} from "../change-branch.ts";
import {
  implementationRunSchema,
  type ImplementationRun,
} from "../implementation-run-model.ts";
import { planningRunSchema, type PlanningRun } from "../planning-run-model.ts";
import { phaseProgressSchema, type PhaseProgress } from "../phase-work.ts";
import {
  pendingPhaseTaskPlanningSessionSchema,
  type PendingPhaseTaskPlanningSession,
} from "../phase-task-planning.ts";
import {
  rootPullRequestIdentitySchema,
  type RootPullRequestIdentity,
} from "../root-pull-request.ts";
import {
  pendingImplementationBranchSessionSchema,
  type PendingImplementationBranchSession,
} from "../implementation-branch.ts";
import {
  pendingImplementationReviewSessionSchema,
  type PendingImplementationReviewSession,
} from "../implementation-review.ts";
import {
  pendingPrFeedbackReviewSessionSchema,
  type PendingPrFeedbackReviewSession,
} from "../pr-feedback-review.ts";
import {
  pendingImplementationMergeSessionSchema,
  type PendingImplementationMergeSession,
} from "../implementation-pull-request.ts";
import type { OrchestratorNotificationRequest } from "../../shared/orchestrator-notifications.ts";
import {
  orchestratorChangeSchema,
  type ActionLink,
  type OrchestratorChange,
} from "../../shared/orchestrator.ts";
import { z } from "zod";

export interface WorkflowState {
  readonly changeBranch: ChangeBranch | null;
  readonly activeBranch: ChangeBranch | PlanningBranch | ImplementationBranch | null;
  readonly change: OrchestratorChange | null;
  readonly implementationRun: ImplementationRun | null;
  readonly planningRun: PlanningRun | null;
  readonly phaseProgress: PhaseProgress | null;
  readonly rootPullRequest: RootPullRequestIdentity | null;
  readonly phaseTarget:
    | { readonly kind: "planning"; readonly phaseNumber: number }
    | { readonly kind: "implementation"; readonly phaseNumber: number; readonly runNumber: number }
    | null;
  readonly pendingChangeInitializationSession: PendingChangeInitializationSession | null;
  readonly pendingPlanningBranchSession: PendingPlanningBranchSession | null;
  readonly pendingPlanningMergeSession: PendingPlanningMergeSession | null;
  readonly pendingImplementationBranchSession: PendingImplementationBranchSession | null;
  readonly pendingArtifactSession: PendingArtifactSession | null;
  readonly pendingReviewSession: PendingReviewSession | null;
  readonly pendingFindingResolutionSession: PendingFindingResolutionSession | null;
  readonly pendingImplementationFindingResolutionSession:
    | PendingImplementationFindingResolutionSession
    | null;
  readonly pendingTaskExecutionSession: PendingTaskExecutionSession | null;
  readonly pendingImplementationReviewSession: PendingImplementationReviewSession | null;
  readonly pendingPrFeedbackReviewSession: PendingPrFeedbackReviewSession | null;
  readonly pendingImplementationMergeSession: PendingImplementationMergeSession | null;
  readonly pendingPhaseTaskPlanningSession: PendingPhaseTaskPlanningSession | null;
}

export type WorkflowStepId = string;

/**
 * Схема состояния workflow на границе хранения.
 * При добавлении нового поля его нужно добавить и сюда: это не позволит
 * случайно записать в checkpoint значение, которое нельзя восстановить из JSON.
 */
export const workflowStateSchema = z
  .object({
    changeBranch: changeBranchSchema.nullable(),
    activeBranch: z
      .union([changeBranchSchema, planningBranchSchema, implementationBranchSchema])
      .nullable(),
    change: orchestratorChangeSchema.nullable().default(null),
    implementationRun: implementationRunSchema.nullable().default(null),
    planningRun: planningRunSchema.nullable().default(null),
    phaseProgress: phaseProgressSchema.nullable().default(null),
    rootPullRequest: rootPullRequestIdentitySchema.nullable().default(null),
    phaseTarget: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("planning"),
        phaseNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }).strict(),
      z.object({
        kind: z.literal("implementation"),
        phaseNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        runNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }).strict(),
    ]).nullable().default(null),
    pendingChangeInitializationSession: pendingChangeInitializationSessionSchema
      .nullable()
      .default(null),
    pendingPlanningBranchSession: pendingPlanningBranchSessionSchema
      .nullable()
      .default(null),
    pendingPlanningMergeSession: pendingPlanningMergeSessionSchema
      .nullable()
      .default(null),
    pendingImplementationBranchSession: pendingImplementationBranchSessionSchema
      .nullable()
      .default(null),
    pendingArtifactSession: pendingArtifactSessionSchema.nullable().default(null),
    pendingReviewSession: pendingReviewSessionSchema.nullable().default(null),
    pendingFindingResolutionSession: pendingFindingResolutionSessionSchema
      .nullable()
      .default(null),
    pendingImplementationFindingResolutionSession:
      pendingImplementationFindingResolutionSessionSchema.nullable().default(null),
    pendingTaskExecutionSession: pendingTaskExecutionSessionSchema.nullable().default(null),
    pendingImplementationReviewSession: pendingImplementationReviewSessionSchema
      .nullable()
      .default(null),
    pendingPrFeedbackReviewSession: pendingPrFeedbackReviewSessionSchema
      .nullable()
      .default(null),
    pendingImplementationMergeSession: pendingImplementationMergeSessionSchema
      .nullable()
      .default(null),
    pendingPhaseTaskPlanningSession: pendingPhaseTaskPlanningSessionSchema
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((state, context) => {
    const pendingSessions = [
      state.pendingChangeInitializationSession,
      state.pendingPlanningBranchSession,
      state.pendingPlanningMergeSession,
      state.pendingImplementationBranchSession,
      state.pendingArtifactSession,
      state.pendingReviewSession,
      state.pendingFindingResolutionSession,
      state.pendingImplementationFindingResolutionSession,
      state.pendingTaskExecutionSession,
      state.pendingImplementationReviewSession,
      state.pendingPrFeedbackReviewSession,
      state.pendingImplementationMergeSession,
      state.pendingPhaseTaskPlanningSession,
    ].filter(Boolean).length;
    if (pendingSessions > 1) {
      context.addIssue({
        code: "custom",
        path: ["pendingFindingResolutionSession"],
        message: "Workflow не может одновременно восстанавливать несколько агентских сессий",
      });
    }
    if ((state.changeBranch === null) !== (state.activeBranch === null)) {
      context.addIssue({
        code: "custom",
        path: ["activeBranch"],
        message: "Корневая и активная Git-ветки должны устанавливаться вместе",
      });
    }
    if (
      state.change &&
      state.changeBranch !== `change/${state.change.id}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["changeBranch"],
        message: "Корневая Git-ветка не соответствует выбранному change",
      });
    }
    if (
      state.rootPullRequest &&
      state.rootPullRequest.changeBranch !== state.changeBranch
    ) {
      context.addIssue({
        code: "custom",
        path: ["rootPullRequest"],
        message: "Identity корневого pull request не соответствует change-ветке",
      });
    }
    if (state.phaseTarget && (!state.phaseProgress || state.activeBranch !== state.changeBranch)) {
      context.addIssue({
        code: "custom",
        path: ["phaseTarget"],
        message: "Целевая фаза требует progress и активную корневую ветку",
      });
    }
    const initialization = state.pendingChangeInitializationSession;
    if (
      initialization &&
      (state.changeBranch !== initialization.changeBranch ||
        state.activeBranch !== initialization.changeBranch)
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingChangeInitializationSession"],
        message: "Сессия инициализации не соответствует сохранённой корневой ветке",
      });
    }
    const planning = state.pendingPlanningBranchSession;
    if (
      planning &&
      (state.change?.id !== planning.changeId ||
        state.changeBranch !== planning.changeBranch ||
        state.activeBranch !== planning.changeBranch ||
        (state.phaseTarget?.kind === "planning"
          ? planning.planningBranch !== phasePlanningBranchFor(
              planning.changeId,
              state.phaseTarget.phaseNumber,
            )
          : planning.planningBranch !== initialPlanningBranchFor(planning.changeId)))
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingPlanningBranchSession"],
        message: "Сессия planning-ветки не соответствует сохранённому change",
      });
    }
    const merge = state.pendingPlanningMergeSession;
    if (
      merge &&
      (state.change?.id !== merge.changeId ||
        state.changeBranch !== merge.changeBranch ||
        state.activeBranch !== merge.planningBranch)
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingPlanningMergeSession"],
        message: "Сессия merge-gate не соответствует сохранённым веткам change",
      });
    }
    const review = state.pendingReviewSession;
    if (
      review &&
      (state.change?.id !== review.changeId ||
        state.changeBranch !== review.parentBranch ||
        state.activeBranch !== review.reviewBranch)
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingReviewSession"],
        message: "Сессия review не соответствует сохранённым веткам change",
      });
    }
    for (const [path, finding] of [
      ["pendingFindingResolutionSession", state.pendingFindingResolutionSession],
      [
        "pendingImplementationFindingResolutionSession",
        state.pendingImplementationFindingResolutionSession,
      ],
    ] as const) {
      if (
        finding &&
        (state.change?.id !== finding.changeId || state.activeBranch !== finding.branch)
      ) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: "Сессия finding не соответствует сохранённым change и activeBranch",
        });
      }
    }
    const task = state.pendingTaskExecutionSession;
    if (
      task &&
      (state.change?.id !== task.changeId ||
        state.activeBranch !== task.implementationBranch ||
        !state.implementationRun ||
        state.implementationRun.changeBranch !== task.changeBranch ||
        state.implementationRun.phaseNumber !== task.phaseNumber ||
        state.implementationRun.rootBaselineCommit !== task.rootBaselineCommit ||
        state.implementationRun.repository.host !== task.repositoryHost ||
        state.implementationRun.repository.nameWithOwner.toLowerCase() !==
          task.repositoryNameWithOwner.toLowerCase() ||
        state.implementationRun.repository.url !== task.repositoryUrl)
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingTaskExecutionSession"],
        message: "Сессия задачи не соответствует сохранённым change и activeBranch",
      });
    }
    const run = state.implementationRun;
    if (
      run &&
      (state.change?.id !== run.changeId ||
        state.changeBranch !== run.changeBranch ||
        state.activeBranch !== run.implementationBranch)
    ) {
      context.addIssue({
        code: "custom",
        path: ["implementationRun"],
        message: "Implementation-run не соответствует сохранённым change и веткам",
      });
    }
    if (
      run &&
      (!state.phaseProgress ||
        state.phaseProgress.nextImplementationRun <= run.runNumber ||
        !state.phaseProgress.phases.some(({ number }) => number === run.phaseNumber) ||
        !state.phaseProgress.tasks.some(
          ({ number }) => Number(number.split(".")[0]) === run.phaseNumber,
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["implementationRun"],
        message: "Implementation-run не соответствует durable progress целевой фазы",
      });
    }
    const implementationBranch = state.pendingImplementationBranchSession;
    if (
      implementationBranch &&
      (state.change?.id !== implementationBranch.changeId ||
        state.changeBranch !== implementationBranch.changeBranch ||
        state.activeBranch !== implementationBranch.changeBranch ||
        state.phaseTarget?.kind !== "implementation" ||
        implementationBranch.phaseNumber !== state.phaseTarget.phaseNumber ||
        implementationBranch.runNumber !== state.phaseTarget.runNumber ||
        implementationBranch.implementationBranch !== implementationBranchForRun(
          implementationBranch.changeId,
          state.phaseTarget.phaseNumber,
          state.phaseTarget.runNumber,
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingImplementationBranchSession"],
        message: "Сессия подготовки implementation-ветки не соответствует change",
      });
    }
    for (const [path, session] of [
      ["pendingImplementationReviewSession", state.pendingImplementationReviewSession],
      ["pendingPrFeedbackReviewSession", state.pendingPrFeedbackReviewSession],
      ["pendingImplementationMergeSession", state.pendingImplementationMergeSession],
    ] as const) {
      if (
        session &&
        (state.change?.id !== session.changeId ||
          state.activeBranch !== session.implementationBranch ||
          !run ||
          run.changeBranch !== session.changeBranch ||
          run.rootBaselineCommit !== session.rootBaselineCommit)
      ) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: "Implementation-сессия не соответствует change и activeBranch",
        });
      }
    }
    const implementationReview = state.pendingImplementationReviewSession;
    if (
      implementationReview &&
      run &&
      (run.repository.host !== implementationReview.repository.host ||
        run.repository.nameWithOwner.toLowerCase() !==
          implementationReview.repository.nameWithOwner.toLowerCase() ||
        run.repository.url !== implementationReview.repository.url ||
        run.batch.kind !== "collecting" ||
        run.batch.baseCommit !== implementationReview.baseCommit ||
        run.batch.headCommit !== implementationReview.reviewedHead)
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingImplementationReviewSession"],
        message: "Implementation review session не соответствует текущему run-пакету",
      });
    }
    const feedback = state.pendingPrFeedbackReviewSession;
    if (
      feedback &&
      run &&
      (run.batch.kind !== "empty" ||
        run.lastDeliveryHead !== feedback.rangeHead ||
        run.batch.baseCommit !== feedback.baselineCommit)
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingPrFeedbackReviewSession"],
        message: "Feedback review session не соответствует implementation-run",
      });
    }
    const implementationMerge = state.pendingImplementationMergeSession;
    if (
      implementationMerge &&
      run &&
      (run.batch.kind !== "empty" ||
        run.publication.kind === "unpublished" ||
        run.publication.number !== implementationMerge.pullRequestNumber ||
        run.batch.baseCommit !== implementationMerge.finalImplementationHead)
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingImplementationMergeSession"],
        message: "Implementation merge session не соответствует финальному run",
      });
    }
    const implementationFinding = state.pendingImplementationFindingResolutionSession;
    if (implementationFinding && !run && !state.planningRun) {
      context.addIssue({
        code: "custom",
        path: ["pendingImplementationFindingResolutionSession"],
        message: "Implementation finding session требует implementation- или planning-run",
      });
    }
    const planningRun = state.planningRun;
    if (
      planningRun &&
      (state.change?.id !== planningRun.changeId ||
        state.changeBranch !== planningRun.changeBranch ||
        state.activeBranch !== planningRun.planningBranch)
    ) {
      context.addIssue({
        code: "custom",
        path: ["planningRun"],
        message: "Planning-run не соответствует сохранённым change и веткам",
      });
    }
    if (planningRun && run) {
      context.addIssue({
        code: "custom",
        path: ["planningRun"],
        message: "Planning-run и implementation-run взаимоисключающие",
      });
    }
    const phasePlanning = state.pendingPhaseTaskPlanningSession;
    if (
      phasePlanning &&
      (!planningRun ||
        state.activeBranch !== phasePlanning.planningBranch ||
        planningRun.phaseNumber !== phasePlanning.phaseNumber ||
        planningRun.rootBaselineCommit !== phasePlanning.baselineCommit ||
        JSON.stringify(planningRun.baselineProgress) !==
          JSON.stringify(phasePlanning.baselineProgress))
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingPhaseTaskPlanningSession"],
        message: "Phase planning session не соответствует planning-run",
      });
    }
  });

export const workflowCheckpointSchema = z
  .object({
    version: z.literal(5),
    nextStepId: z.string().trim().min(1).max(128),
    state: workflowStateSchema,
  })
  .strict();

export type WorkflowCheckpoint = z.infer<typeof workflowCheckpointSchema>;

export interface WorkflowStepContext {
  readonly signal: AbortSignal;
  readonly state: Readonly<WorkflowState>;
  readonly updateActionLinks: (links: readonly ActionLink[]) => void;
  readonly checkpointState: (nextState: WorkflowState) => Promise<void>;
  /** Ошибка доставки записывается движком в лог и возвращает false, не ломая шаг. */
  readonly notify: (notification: OrchestratorNotificationRequest) => Promise<boolean>;
}

export type WorkflowStepResult =
  | {
      kind: "continue";
      next: WorkflowStepId;
      state?: Partial<WorkflowState>;
      summary?: string;
    }
  | {
      kind: "complete";
      state?: Partial<WorkflowState>;
      summary?: string;
    }
  | {
      kind: "halt";
      summary: string;
      message: string;
    };

export type WorkflowStepFunction = (
  context: WorkflowStepContext,
) => Promise<WorkflowStepResult>;

export interface WorkflowStepDefinition {
  readonly id: WorkflowStepId;
  readonly label: string;
  readonly run: WorkflowStepFunction;
}

/**
 * Полный исполняемый контракт workflow. Конкретные зависимости уже связаны
 * со шагами в точке сборки и не видны универсальному движку.
 */
export interface WorkflowDefinition {
  readonly startStepId: WorkflowStepId;
  readonly steps: readonly WorkflowStepDefinition[];
}

export function createInitialWorkflowState(): WorkflowState {
  return {
    changeBranch: null,
    activeBranch: null,
    change: null,
    implementationRun: null,
    planningRun: null,
    phaseProgress: null,
    rootPullRequest: null,
    phaseTarget: null,
    pendingChangeInitializationSession: null,
    pendingPlanningBranchSession: null,
    pendingPlanningMergeSession: null,
    pendingImplementationBranchSession: null,
    pendingArtifactSession: null,
    pendingReviewSession: null,
    pendingFindingResolutionSession: null,
    pendingImplementationFindingResolutionSession: null,
    pendingTaskExecutionSession: null,
    pendingImplementationReviewSession: null,
    pendingPrFeedbackReviewSession: null,
    pendingImplementationMergeSession: null,
    pendingPhaseTaskPlanningSession: null,
  };
}
