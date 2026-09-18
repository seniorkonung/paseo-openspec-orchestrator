import {
  describeRequiredAgentProfileProblem,
  resolveRequiredAgentProfile,
  type AgentProfileReader,
} from "../../agent-profiles.ts";
import {
  ChangeTaskExecutionError,
  type ChangeTaskExecutionService,
} from "../../change-task-execution.ts";
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export interface ExecuteChangeTasksDependencies {
  readonly workspaceDirectory: string;
  readonly readAgentProfiles: AgentProfileReader;
  readonly taskExecution: Pick<ChangeTaskExecutionService, "plan" | "run">;
}

async function executeChangeTasksStep(
  dependencies: ExecuteChangeTasksDependencies,
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const { branch, change } = context.state;
  if (!branch || !change) {
    return {
      kind: "halt",
      summary: "Недостаточно данных для выполнения OpenSpec-задач",
      message: "Git-ветка или OpenSpec change не сохранены; запустите workflow заново",
    };
  }
  if (
    context.state.pendingArtifactSession ||
    context.state.pendingReviewSession ||
    context.state.pendingFindingResolutionSession ||
    context.state.pendingImplementationFindingResolutionSession
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
        change.id,
        branch,
        context.signal,
      );
      if (plan.kind === "complete") {
        return {
          kind: "complete",
          state: { pendingTaskExecutionSession: null },
          summary: `Все OpenSpec-задачи change ${change.id} выполнены`,
        };
      }
      session = plan.session;
      await context.checkpointState({
        ...context.state,
        pendingTaskExecutionSession: session,
      });
    } catch (error) {
      return taskFailure(context, error, "Не удалось определить следующую OpenSpec-задачу");
    }
  }

  let profiles;
  try {
    profiles = await dependencies.readAgentProfiles();
  } catch (error) {
    if (context.signal.aborted) throw error;
    console.error("[OpenSpec] Не удалось перечитать профили перед выполнением задачи", {
      code: errorCode(error),
    });
    return {
      kind: "halt",
      summary: "Не удалось перечитать профили агентов",
      message:
        "Не удалось перечитать профиль High перед выполнением OpenSpec-задачи; проверьте Paseo и нажмите «Повторить»",
    };
  }

  const resolution = resolveRequiredAgentProfile(profiles, "High");
  if (resolution.kind === "invalid") {
    const summary = describeRequiredAgentProfileProblem("High", resolution);
    return {
      kind: "halt",
      summary,
      message: `${summary}; исправьте Agent profiles в Paseo и нажмите «Повторить»`,
    };
  }

  try {
    const completed = await dependencies.taskExecution.run({
      workspaceDirectory: dependencies.workspaceDirectory,
      profile: resolution.profile,
      session,
      signal: context.signal,
      onAgentCreated: (agentId) => {
        context.updateActionLinks([
          {
            kind: "agent",
            agentId,
            label: `OpenSpec-задача ${session.taskNumber}`,
          },
        ]);
      },
      onTaskCompleted: async (task) => {
        await context.checkpointState({
          ...context.state,
          branch: task.branch,
          pendingTaskExecutionSession: null,
        });
      },
    });
    return {
      kind: "continue",
      next: "execute-change-tasks",
      state: {
        branch: completed.branch,
        pendingTaskExecutionSession: null,
      },
      summary:
        `Задача ${completed.taskNumber} опубликована в PR #${completed.pullRequest.number}; ` +
        `осталось ${completed.remainingTasks}`,
    };
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
  const summary = error instanceof ChangeTaskExecutionError ? error.message : fallback;
  return {
    kind: "halt",
    summary,
    message: `${summary}; исправьте состояние и нажмите «Повторить»`,
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
