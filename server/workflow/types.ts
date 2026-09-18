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
import { taskBranchSchema } from "../change-task-model.ts";
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
  type ChangeBranch,
} from "../change-branch.ts";
import type { OrchestratorNotificationRequest } from "../../shared/orchestrator-notifications.ts";
import {
  orchestratorChangeSchema,
  type AgentLink,
  type OrchestratorChange,
} from "../../shared/orchestrator.ts";
import { z } from "zod";

export interface WorkflowState {
  readonly changeBranch: ChangeBranch | null;
  readonly activeBranch: string | null;
  readonly change: OrchestratorChange | null;
  readonly pendingChangeInitializationSession: PendingChangeInitializationSession | null;
  readonly pendingPlanningBranchSession: PendingPlanningBranchSession | null;
  readonly pendingPlanningMergeSession: PendingPlanningMergeSession | null;
  readonly pendingArtifactSession: PendingArtifactSession | null;
  readonly pendingReviewSession: PendingReviewSession | null;
  readonly pendingFindingResolutionSession: PendingFindingResolutionSession | null;
  readonly pendingImplementationFindingResolutionSession:
    | PendingImplementationFindingResolutionSession
    | null;
  readonly pendingTaskExecutionSession: PendingTaskExecutionSession | null;
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
    activeBranch: taskBranchSchema.nullable(),
    change: orchestratorChangeSchema.nullable().default(null),
    pendingChangeInitializationSession: pendingChangeInitializationSessionSchema
      .nullable()
      .default(null),
    pendingPlanningBranchSession: pendingPlanningBranchSessionSchema
      .nullable()
      .default(null),
    pendingPlanningMergeSession: pendingPlanningMergeSessionSchema
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
  })
  .strict()
  .superRefine((state, context) => {
    const pendingSessions = [
      state.pendingChangeInitializationSession,
      state.pendingPlanningBranchSession,
      state.pendingPlanningMergeSession,
      state.pendingArtifactSession,
      state.pendingReviewSession,
      state.pendingFindingResolutionSession,
      state.pendingImplementationFindingResolutionSession,
      state.pendingTaskExecutionSession,
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
        state.activeBranch !== planning.changeBranch)
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
      (state.change?.id !== task.changeId || state.activeBranch !== task.parentBranch)
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingTaskExecutionSession"],
        message: "Сессия задачи не соответствует сохранённым change и activeBranch",
      });
    }
  });

export const workflowCheckpointSchema = z
  .object({
    version: z.literal(3),
    nextStepId: z.string().trim().min(1).max(128),
    state: workflowStateSchema,
  })
  .strict();

export type WorkflowCheckpoint = z.infer<typeof workflowCheckpointSchema>;

export interface WorkflowStepContext {
  readonly signal: AbortSignal;
  readonly state: Readonly<WorkflowState>;
  readonly updateActionLinks: (links: readonly AgentLink[]) => void;
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
    pendingChangeInitializationSession: null,
    pendingPlanningBranchSession: null,
    pendingPlanningMergeSession: null,
    pendingArtifactSession: null,
    pendingReviewSession: null,
    pendingFindingResolutionSession: null,
    pendingImplementationFindingResolutionSession: null,
    pendingTaskExecutionSession: null,
  };
}
