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
import type { GitBranchDecision } from "../git-branch.ts";
import type { OrchestratorNotificationRequest } from "../../shared/orchestrator-notifications.ts";
import {
  orchestratorChangeSchema,
  type AgentLink,
  type OrchestratorChange,
} from "../../shared/orchestrator.ts";
import { z } from "zod";

export interface WorkflowState {
  readonly branch: Extract<GitBranchDecision, { kind: "non-main" }>["name"] | null;
  readonly change: OrchestratorChange | null;
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
    branch: z.string().trim().max(512).nullable(),
    change: orchestratorChangeSchema.nullable().default(null),
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
  });

export const workflowCheckpointSchema = z
  .object({
    version: z.literal(2),
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
    branch: null,
    change: null,
    pendingArtifactSession: null,
    pendingReviewSession: null,
    pendingFindingResolutionSession: null,
    pendingImplementationFindingResolutionSession: null,
    pendingTaskExecutionSession: null,
  };
}
