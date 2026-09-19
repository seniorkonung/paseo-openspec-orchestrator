import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { CompleteRequiredAgentProfile } from "./agent-profiles.ts";
import {
  FIXED_BRANCH_RULE,
  NO_GITHUB_RULE,
  OPENSPEC_CLI_RULE,
  STAGE_SCOPE_RULE,
  UNTRUSTED_INPUT_RULE,
  buildAgentPrompt,
  completionInstruction,
} from "./agent-prompt.ts";
import {
  combineAbortSignals,
  throwIfSignalAborted,
} from "./agent-session-control.ts";
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-command.ts";
import {
  readTaskGitRoot,
} from "./change-task-gateway.ts";
import {
  ChangeTaskExecutionError,
  MAX_TASKS,
  TASK_REMOTE,
  pendingTaskExecutionSessionSchema,
  taskCompletionInputSchema,
  taskIdSchema,
  taskNumberSchema,
  type ChangeTaskExecutionPlan,
  type CompletedChangeTask,
  type PendingTaskExecutionSession,
} from "./change-task-model.ts";
import {
  inspectTaskExecutionRecovery,
  planChangeTaskExecution,
  verifyCompletedTask,
} from "./change-task-publication.ts";
import { createManagedAgentSession } from "./managed-agent-session.ts";
import {
  McpToolError,
  OrchestratorMcpToolHost,
  defineMcpTool,
} from "./orchestrator-mcp-tool-host.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import { implementationBranchSchema } from "./change-branch.ts";
import type { ImplementationRun } from "./implementation-run-model.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  updateAgentNotificationLabel,
  type AgentNotificationLabelUpdater,
} from "./paseo-agent-labels.ts";

export {
  ChangeTaskExecutionError,
  pendingTaskExecutionSessionSchema,
} from "./change-task-model.ts";
export type {
  ChangeTaskExecutionPlan,
  CompletedChangeTask,
  PendingTaskExecutionSession,
} from "./change-task-model.ts";

type PaseoApi = PluginHandlerContext["paseo"];
type PaseoWorkspace = ReturnType<PaseoApi["workspaces"]["ref"]>;
type PaseoAgent = Awaited<ReturnType<PaseoWorkspace["agents"]["create"]>>;

export type TaskPaseoAgentCreator = (
  options: Parameters<PaseoWorkspace["agents"]["create"]>[0],
) => Promise<PaseoAgent>;

const APPLY_CHANGE_SKILL = "openspec-apply-change";
const DEFAULT_AGENT_DRAIN_TIMEOUT_MS = 15_000;

export interface ChangeTaskExecutionRequest {
  readonly workspaceDirectory: string;
  readonly profile: CompleteRequiredAgentProfile;
  readonly session: PendingTaskExecutionSession;
  readonly signal: AbortSignal;
  readonly onAgentCreated: (agentId: string) => void;
  readonly onTaskCompleted: (completion: CompletedChangeTask) => Promise<void>;
}

export interface ChangeTaskExecutionService {
  plan(
    workspaceDirectory: string,
    run: ImplementationRun,
    signal?: AbortSignal,
  ): Promise<ChangeTaskExecutionPlan>;
  run(request: ChangeTaskExecutionRequest): Promise<CompletedChangeTask>;
}

interface McpHostFactory {
  listen(): Promise<OrchestratorMcpToolHost>;
}

export interface ChangeTaskExecutionServiceOptions {
  readonly createAgent: TaskPaseoAgentCreator;
  readonly command?: BoundedCommandRunner;
  readonly updateNotificationLabel?: AgentNotificationLabelUpdater;
  readonly mcpHost?: McpHostFactory;
  readonly agentDrainTimeoutMs?: number;
  readonly logger?: Pick<Console, "error" | "warn">;
}

export function createChangeTaskExecutionService(
  options: ChangeTaskExecutionServiceOptions,
): ChangeTaskExecutionService {
  const command = options.command ?? runBoundedCommand;
  const updateNotificationLabel =
    options.updateNotificationLabel ?? updateAgentNotificationLabel;
  const mcpHost = options.mcpHost ?? OrchestratorMcpToolHost;
  const agentDrainTimeoutMs =
    options.agentDrainTimeoutMs ?? DEFAULT_AGENT_DRAIN_TIMEOUT_MS;
  const logger = options.logger ?? console;

  return {
    plan: (workspaceDirectory, run, signal) =>
      planChangeTaskExecution(command, workspaceDirectory, run, signal),

    async run(request) {
      throwIfSignalAborted(request.signal);
      const session = pendingTaskExecutionSessionSchema.parse(request.session);
      const gitRoot = await readTaskGitRoot(
        command,
        request.workspaceDirectory,
        request.signal,
      );
      const recovery = await inspectTaskExecutionRecovery(
        command,
        request.workspaceDirectory,
        gitRoot,
        session,
        request.signal,
      );

      const host = await mcpHost.listen();
      let completedTask: CompletedChangeTask | null = null;
      const agentSession = createManagedAgentSession<CompletedChangeTask>({
        signal: request.signal,
        host,
        updateNotificationLabel,
        agentDrainTimeoutMs,
        logContext: "выполнение OpenSpec-задачи",
        logger,
      });

      const outputSchema = z
        .object({
          changeId: openSpecChangeIdSchema,
          taskId: taskIdSchema,
          taskNumber: taskNumberSchema,
          branch: implementationBranchSchema,
          commit: commitHashSchema,
          remainingTasks: z.number().int().nonnegative().max(MAX_TASKS),
        })
        .strict();

      const scope = await agentSession.openScope(() => host.expose({
        complete_change_task: defineMcpTool({
          description:
            "Проверить реализацию, единственный commit и push одной OpenSpec-задачи",
          inputSchema: taskCompletionInputSchema,
          outputSchema,
          execute: (_input, toolContext) =>
            agentSession.runExclusive(async () => {
              if (completedTask) return completionToolResult(completedTask);
              const combined = combineAbortSignals(request.signal, toolContext.signal);
              const { signal } = combined;
              try {
                const activeAgent = await agentSession.waitForAgent(signal);
                let verified: CompletedChangeTask;
                try {
                  verified = await verifyCompletedTask(
                    command,
                    request.workspaceDirectory,
                    gitRoot,
                    session,
                    signal,
                  );
                } catch (error) {
                  if (error instanceof ChangeTaskExecutionError) {
                    throw new McpToolError(error.message);
                  }
                  if (signal.aborted) throw error;
                  logger.error("[OpenSpec] Не удалось проверить выполненную задачу", {
                    changeId: session.changeId,
                    taskNumber: session.taskNumber,
                    code: errorCode(error),
                  });
                  throw new McpToolError(
                    "Не удалось проверить выполненную OpenSpec-задачу",
                  );
                }

                try {
                  await agentSession.disableNotifications(signal);
                } catch (error) {
                  if (signal.aborted) throw error;
                  logger.error("[OpenSpec] Не удалось отключить ntfy для task-агента", {
                    agentId: activeAgent.id,
                    code: errorCode(error),
                  });
                  throw new McpToolError(
                    "Не удалось отключить финальное уведомление агента; повторите вызов",
                  );
                }

                try {
                  await request.onTaskCompleted(verified);
                } catch (error) {
                  logger.error("[OpenSpec] Не удалось сохранить завершение задачи", {
                    changeId: session.changeId,
                    taskNumber: session.taskNumber,
                    code: errorCode(error),
                  });
                  try {
                    await agentSession.restoreNotifications(signal);
                  } catch (restoreError) {
                    logger.warn("[OpenSpec] Не удалось восстановить ntfy task-агента", {
                      agentId: activeAgent.id,
                      code: errorCode(restoreError),
                    });
                  }
                  throw new McpToolError(
                    "Не удалось надёжно сохранить завершение задачи; повторите вызов",
                  );
                }

                completedTask = verified;
                agentSession.complete(verified);
                return completionToolResult(verified);
              } finally {
                combined.dispose();
              }
            }),
        }),
      }));

      try {
        const config = scope.configureAgent({
          provider: `${request.profile.provider}/${request.profile.model}`,
          modeId: request.profile.modeId,
          thinkingOptionId: request.profile.thinkingOptionId,
          ...(request.profile.featureValues == null
            ? {}
            : { featureValues: request.profile.featureValues }),
        });
        const agent = await agentSession.launchAgent(
          () =>
            options.createAgent({
              config,
              title: `OpenSpec-задача ${session.taskNumber}: ${session.changeId}`,
              labels: { ntfy: "true" },
            }),
          request.onAgentCreated,
        );

        const catalog = await agent.commands();
        const loadedCommands = new Set(catalog.commands.map(({ name }) => name));
        if (catalog.error || !loadedCommands.has(APPLY_CHANGE_SKILL)) {
          throw new ChangeTaskExecutionError(
            `Агент не загрузил обязательный skill ${APPLY_CHANGE_SKILL}`,
          );
        }
        await agent.send(
          changeTaskExecutionPrompt({
            session,
            alreadyCommitted: recovery.alreadyCommitted,
          }),
        );

        const completed = await agentSession.waitForCompletion();
        await new Promise<void>((resolveDrain) => setImmediate(resolveDrain));
        await agentSession.drainAgent();
        return completed;
      } finally {
        await agentSession.close();
      }
    },
  };
}

export function changeTaskExecutionPrompt(input: {
  readonly session: PendingTaskExecutionSession;
  readonly alreadyCommitted: boolean;
}): string {
  const { session } = input;
  const applyInstruction = input.alreadyCommitted
    ? "This is a recovery session: the selected task is already implemented in the one expected commit. Do not invoke the apply skill, change files, or create or amend another commit; continue only with push and completion."
    : `Invoke exactly this skill command as the implementation request:

\`$openspec-apply-change ${session.changeId} Выполни задачу ${session.taskNumber}. К другим задачам не приступай.\`

Stop the apply loop right after task ${session.taskNumber}: implement its full specified behavior, run the relevant verification, and mark only its checkbox complete. Leave the description, numbering, order, and completion state of every other task unchanged.`;
  const commitInstruction = input.alreadyCommitted
    ? ""
    : `When implementation and verification are complete, stage only the files task ${session.taskNumber} needed and create exactly one commit after the baseline, with a Conventional Commits subject shorter than 72 characters. Do not amend, merge, or add a second commit.`;

  return buildAgentPrompt({
    role: "You own exactly one OpenSpec implementation task.",
    communication: "blocker-only",
    workflowData: {
      changeId: session.changeId,
      taskNumber: session.taskNumber,
      taskDescription: session.taskDescription,
      changeBranch: session.changeBranch,
      implementationBranch: session.implementationBranch,
      rootBaselineCommit: session.rootBaselineCommit,
      baselineCommit: session.baselineCommit,
      repository:
        session.repositoryHost === "github.com"
          ? session.repositoryNameWithOwner
          : `${session.repositoryHost}/${session.repositoryNameWithOwner}`,
      remote: TASK_REMOTE,
      alreadyCommitted: input.alreadyCommitted,
    },
    rules: [
      UNTRUSTED_INPUT_RULE,
      OPENSPEC_CLI_RULE,
      NO_GITHUB_RULE,
      FIXED_BRANCH_RULE,
      STAGE_SCOPE_RULE,
    ],
    body: [
      applyInstruction,
      commitInstruction,
      `Publish the task commit with \`git push --set-upstream origin ${session.implementationBranch}\`.`,
    ],
    completion: completionInstruction({
      tool: "complete_change_task",
      retryScope: "this task's commit or push state",
      afterSuccess:
        "After it succeeds, end the turn silently instead of sending another message.",
    }),
  });
}

function completionToolResult(task: CompletedChangeTask): {
  readonly text: string;
  readonly data: CompletedChangeTask;
} {
  return {
    text: task.remainingTasks === 0
      ? `Задача ${task.taskNumber} принята; все OpenSpec-задачи завершены`
      : `Задача ${task.taskNumber} принята; workflow запустит следующую задачу`,
    data: task,
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}
