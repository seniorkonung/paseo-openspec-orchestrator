import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
  type AgentProfileReader,
} from "../../agent-profiles.ts";
import {
  ChangeTaskExecutionError,
  type ChangeTaskExecutionService,
} from "../../change-task-execution.ts";
import { assignTaskExecutionProfile } from "../../change-task-model.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";
import {
  collectImplementationTask,
  extendImplementationBatch,
} from "../../implementation-run-model.ts";
import type { TaskProfileService } from "../../task-profile-assessment.ts";
import { ESCALATION_PROFILE } from "../../task-profile-level.ts";
import {
  TaskProfilesError,
  executionProfileFor,
  listTaskNumbers,
  recordForTask,
} from "../../task-profile-model.ts";
import { boundedMessage, boundedSummary } from "../bounded-text.ts";

export interface ExecuteChangeTasksDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly taskExecution: Pick<ChangeTaskExecutionService, "plan" | "run">;
  readonly taskProfiles: Pick<TaskProfileService, "inspect">;
}

async function executeChangeTasksStep(
  dependencies: ExecuteChangeTasksDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { activeBranch, change, implementationRun } = context.state;
  if (!activeBranch || !change || !implementationRun) {
    return {
      kind: "halt",
      summary: "Недостаточно данных для выполнения OpenSpec-задач",
      message: "Git-ветка или OpenSpec change не сохранены; запустите workflow заново",
    };
  }
  if (
    context.state.pendingArtifactSession ||
    context.state.pendingReviewSession ||
    context.state.pendingFindingDecisionSession ||
    context.state.pendingFindingResolutionSession ||
    context.state.pendingImplementationFindingDecisionSession ||
    context.state.pendingImplementationFindingResolutionSession ||
    context.state.pendingTaskProfileAssessmentSession
  ) {
    return {
      kind: "halt",
      summary: "Другая незавершённая сессия блокирует выполнение задач",
      message: "Завершите предыдущую агентскую сессию и запустите workflow заново",
    };
  }

  let session = context.state.pendingTaskExecutionSession;
  if (!session) {
    try {
      const plan = await dependencies.taskExecution.plan(
        dependencies.workspaceDirectory,
        implementationRun,
        context.signal,
      );
      if (plan.kind === "complete") {
        if (implementationRun.batch.kind === "collecting") {
          return {
            kind: "continue",
            next: "review-implementation",
            state: { pendingTaskExecutionSession: null },
            summary: `Пакет из ${implementationRun.batch.tasks.length} задач готов к implementation review`,
          };
        }
        // Пакет пуст: с его начала в фазе не завершено ни одной задачи.
        // Когда run ещё ничего не проверял, задачи фазы убраны или перенесены
        // вне этапа, и следующую работу нужно выбрать заново.
        return {
          kind: "continue",
          next: "inspect-phase-work",
          state: { pendingTaskExecutionSession: null, implementationRun: null },
          summary: implementationRun.publication.kind === "unreviewed"
            ? `В Phase ${implementationRun.phaseNumber} не осталось задач для выполнения`
            : plan.reason === "phase-complete"
              ? `Все задачи Phase ${implementationRun.phaseNumber} выполнены`
              : `Все OpenSpec-задачи change ${change.id} выполнены`,
        };
      }
      // Ни одна задача фазы не запускается, пока не оценены все её
      // незавершённые задачи: так новые и изменённые задачи оцениваются
      // одной сессией, а не по одной.
      const taskProfiles = await dependencies.taskProfiles.inspect(
        dependencies.workspaceDirectory,
        implementationRun,
        context.signal,
      );
      if (taskProfiles.kind === "assessment-required") {
        return {
          kind: "continue",
          next: "assess-task-profiles",
          state: { pendingTaskExecutionSession: null },
          summary: `Нужна оценка профилей задач Phase ${implementationRun.phaseNumber}: ${listTaskNumbers(taskProfiles.session.tasks.map(({ number }) => number))}`,
        };
      }
      const task = { number: plan.session.taskNumber, description: plan.session.taskDescription };
      const record = recordForTask(taskProfiles.records, task);
      if (!record) {
        throw new TaskProfilesError(`Для задачи ${task.number} нет действующей оценки профиля`);
      }
      const assigned = assignTaskExecutionProfile(plan.session, executionProfileFor(record));
      await context.checkpointState({
        ...context.state,
        pendingTaskExecutionSession: assigned,
      });
      session = assigned;
    } catch (error) {
      return taskFailure(context, error, "Не удалось определить следующую OpenSpec-задачу");
    }
  }
  const pending = session;

  let agentProfiles;
  try {
    agentProfiles = await dependencies.readAgentProfiles();
  } catch (error) {
    if (context.signal.aborted) throw error;
    console.error("[OpenSpec] Не удалось перечитать профили перед выполнением задачи", {
      code: errorCode(error),
    });
    return {
      kind: "halt",
      summary: "Не удалось перечитать профили агентов",
      message:
        `Не удалось перечитать профиль ${pending.profile} перед выполнением OpenSpec-задачи; проверьте Paseo и нажмите «Повторить»`,
    };
  }

  const resolution = resolveRequiredAgentProfile(agentProfiles, pending.profile);
  if (resolution.kind === "invalid") {
    const summary = describeRequiredAgentProfileProblem(pending.profile, resolution);
    return {
      kind: "halt",
      summary,
      message: `${summary}; исправьте Agent profiles в Paseo и нажмите «Повторить»`,
    };
  }

  try {
    const outcome = await dependencies.taskExecution.run({
      workspaceDirectory: dependencies.workspaceDirectory,
      profile: resolution.profile,
      session: pending,
      signal: context.signal,
      onAgentCreated: (agentId) => {
        context.updateActionLinks([
          {
            kind: "agent",
            agentId,
            label: `OpenSpec-задача ${pending.taskNumber} · ${pending.profile}`,
          },
        ]);
      },
      onTaskCompleted: async (task) => {
        const nextRun = collectImplementationTask(implementationRun, {
          taskId: task.taskId,
          taskNumber: task.taskNumber,
          commit: task.commit,
        });
        await context.checkpointState({
          ...context.state,
          activeBranch: task.branch,
          implementationRun: nextRun,
          pendingTaskExecutionSession: null,
        });
      },
      onTaskEscalated: async (escalation) => {
        await context.checkpointState({
          ...context.state,
          implementationRun: extendImplementationBatch(implementationRun, escalation.commit),
          pendingTaskExecutionSession: null,
        });
      },
    });
    switch (outcome.kind) {
      case "completed": {
        const completed = outcome.task;
        const nextRun = collectImplementationTask(implementationRun, {
          taskId: completed.taskId,
          taskNumber: completed.taskNumber,
          commit: completed.commit,
        });
        return {
          kind: "continue",
          next: "execute-change-tasks",
          state: {
            activeBranch: completed.branch,
            implementationRun: nextRun,
            pendingTaskExecutionSession: null,
          },
          summary:
            `Задача ${completed.taskNumber} (${pending.profile}) добавлена в implementation-пакет; осталось ${completed.remainingTasks}`,
        };
      }
      case "escalated": {
        const { escalation } = outcome;
        return {
          kind: "continue",
          next: "execute-change-tasks",
          state: {
            implementationRun: extendImplementationBatch(implementationRun, escalation.commit),
            pendingTaskExecutionSession: null,
          },
          summary: boundedSummary(
            `Задача ${escalation.taskNumber} передана с ${pending.profile} на ${ESCALATION_PROFILE}: ${escalation.reason}`,
          ),
        };
      }
    }
  } catch (error) {
    return taskFailure(context, error, "Не удалось завершить OpenSpec-задачу");
  }
}

function taskFailure(
  context: WorkflowStepContext,
  error: unknown,
  fallback: string,
): WorkflowStepResult {
  if (context.signal.aborted) throw error;
  console.error("[OpenSpec] Ошибка выполнения OpenSpec-задачи", {
    code: errorCode(error),
  });
  const reason =
    error instanceof ChangeTaskExecutionError || error instanceof TaskProfilesError
      ? error.message
      : fallback;
  return {
    kind: "halt",
    summary: boundedSummary(reason),
    message: boundedMessage(`${reason}; исправьте состояние и нажмите «Повторить»`),
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}

export function createExecuteChangeTasksStep(
  dependencies: ExecuteChangeTasksDependencies,
): WorkflowStepDefinition {
  return {
    id: "execute-change-tasks",
    label: "Выполняю следующую OpenSpec-задачу",
    run: (context) => executeChangeTasksStep(dependencies, context),
  };
}
