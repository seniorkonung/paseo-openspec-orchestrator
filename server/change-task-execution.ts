import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { CompleteRequiredAgentProfile } from "./agent-profiles.ts";
import {
  FIXED_BRANCH_RULE,
  NO_GITHUB_RULE,
  OPENSPEC_CLI_RULE,
  STAGE_SCOPE_RULE,
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
  verifyTaskEscalation,
} from "./change-task-publication.ts";
import { createManagedAgentSession, type AgentResourceReleaser } from "./managed-agent-session.ts";
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
import { deliverRootCommit, RootBranchDeliveryError } from "./root-branch-delivery.ts";
import {
  RESUMABLE_SESSION,
  staleSession,
  type SessionAssessment,
} from "./session-assessment.ts";
import type { TaskProfileService } from "./task-profile-assessment.ts";
import { ESCALATION_PROFILE, taskProfileTextSchema } from "./task-profile-level.ts";
import { TaskProfilesError } from "./task-profile-model.ts";

export {
  ChangeTaskExecutionError,
  pendingTaskExecutionSessionSchema,
} from "./change-task-model.ts";
export type {
  ChangeTaskExecutionPlan,
  CompletedChangeTask,
  PendingTaskExecutionSession,
  PlannedTaskExecutionSession,
} from "./change-task-model.ts";

type PaseoApi = PluginHandlerContext["paseo"];
type PaseoWorkspace = ReturnType<PaseoApi["workspaces"]["ref"]>;
type PaseoAgent = Awaited<ReturnType<PaseoWorkspace["agents"]["create"]>>;

export type TaskPaseoAgentCreator = (
  options: Parameters<PaseoWorkspace["agents"]["create"]>[0],
) => Promise<PaseoAgent>;

const APPLY_CHANGE_SKILL = "openspec-apply-change";
const COMPLETION_TOOL = "complete_change_task";
const ESCALATION_TOOL = "escalate_change_task";

const escalationInputSchema = z.object({ reason: taskProfileTextSchema }).strict();
const escalationOutputSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    taskNumber: taskNumberSchema,
    profile: z.literal(ESCALATION_PROFILE),
    commit: commitHashSchema,
  })
  .strict();
const DEFAULT_AGENT_DRAIN_TIMEOUT_MS = 15_000;

/** Задача, которую агент слабого профиля передал профилю `ESCALATION_PROFILE`. */
export interface EscalatedChangeTask {
  readonly changeId: string;
  readonly taskId: string;
  readonly taskNumber: string;
  readonly reason: string;
  /** Опубликованный HEAD: коммит эскалации поверх коммитов агента. */
  readonly commit: string;
}

export type ChangeTaskExecutionOutcome =
  | { readonly kind: "completed"; readonly task: CompletedChangeTask }
  | { readonly kind: "escalated"; readonly escalation: EscalatedChangeTask };

export interface ChangeTaskExecutionRequest {
  readonly workspaceDirectory: string;
  /** Профиль Paseo, совпадающий с `session.profile`. */
  readonly profile: CompleteRequiredAgentProfile;
  readonly session: PendingTaskExecutionSession;
  readonly signal: AbortSignal;
  readonly onAgentCreated: (agentId: string) => void;
  readonly onTaskCompleted: (completion: CompletedChangeTask) => Promise<void>;
  readonly onTaskEscalated: (escalation: EscalatedChangeTask) => Promise<void>;
}

export interface ChangeTaskExecutionService {
  plan(
    workspaceDirectory: string,
    run: ImplementationRun,
    signal?: AbortSignal,
  ): Promise<ChangeTaskExecutionPlan>;
  /**
   * Оценивает сохранённую task-сессию, не меняя репозиторий. Сессия устарела,
   * когда её задача, список задач или baseline больше не соответствуют
   * репозиторию: продолжить её нельзя, задачу нужно выбрать заново.
   */
  assess(
    workspaceDirectory: string,
    session: PendingTaskExecutionSession,
    signal: AbortSignal,
  ): Promise<SessionAssessment>;
  run(request: ChangeTaskExecutionRequest): Promise<ChangeTaskExecutionOutcome>;
}

interface McpHostFactory {
  listen(): Promise<OrchestratorMcpToolHost>;
}

export interface ChangeTaskExecutionServiceOptions {
  readonly releaseAgent?: AgentResourceReleaser;
  readonly createAgent: TaskPaseoAgentCreator;
  /** Записывает эскалацию задачи в файл профилей. */
  readonly taskProfiles: Pick<TaskProfileService, "recordEscalation">;
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

    async assess(workspaceDirectory, sessionInput, signal) {
      const session = pendingTaskExecutionSessionSchema.parse(sessionInput);
      const gitRoot = await readTaskGitRoot(command, workspaceDirectory, signal);
      const recovery = await inspectTaskExecutionRecovery(
        command,
        workspaceDirectory,
        gitRoot,
        session,
        signal,
      );
      return recovery.kind === "stale" ? staleSession(recovery.reason) : RESUMABLE_SESSION;
    },

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
      // Устаревшую сессию сбрасывает согласование перед шагом; здесь она
      // возможна только при изменении репозитория после него.
      if (recovery.kind === "stale") throw new ChangeTaskExecutionError(recovery.reason);
      const alreadyCommitted = recovery.kind === "committed";

      const profileName = request.profile.name;
      if (
        typeof profileName !== "string" ||
        profileName.trim().toLowerCase() !== session.profile.toLowerCase()
      ) {
        throw new ChangeTaskExecutionError(
          `Профиль агента не совпадает с профилем задачи ${session.profile}`,
        );
      }

      const host = await mcpHost.listen();
      let outcome: ChangeTaskExecutionOutcome | null = null;
      // Эскалация записана в файл профилей, но ещё не подтверждена: задача
      // принадлежит профилю High, и завершать её на текущем профиле нельзя.
      let escalationRecorded = false;
      const agentSession = createManagedAgentSession<ChangeTaskExecutionOutcome>({
        signal: request.signal,
        releaseAgent: options.releaseAgent,
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

      const completionTool = defineMcpTool({
          description:
            "Проверить реализацию, единственный commit и push одной OpenSpec-задачи",
          inputSchema: taskCompletionInputSchema,
          outputSchema,
          execute: (_input, toolContext) =>
            agentSession.runExclusive(async () => {
              if (outcome?.kind === "completed") return completionToolResult(outcome.task);
              if (outcome) throw new McpToolError(escalatedToolMessage(outcome.escalation));
              if (escalationRecorded) {
                throw new McpToolError(
                  `Эскалация задачи ${session.taskNumber} уже записана: повторите ${ESCALATION_TOOL}, чтобы её опубликовать`,
                );
              }
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
                  if (
                    error instanceof ChangeTaskExecutionError ||
                    error instanceof RootBranchDeliveryError
                  ) {
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

                outcome = { kind: "completed", task: verified };
                agentSession.complete(outcome);
                return completionToolResult(verified);
              } finally {
                combined.dispose();
              }
            }),
        });

      const escalationTool = defineMcpTool({
        description: `Передать OpenSpec-задачу профилю ${ESCALATION_PROFILE}, когда её нельзя надёжно выполнить на текущем профиле`,
        inputSchema: escalationInputSchema,
        outputSchema: escalationOutputSchema,
        execute: (input, toolContext) =>
          agentSession.runExclusive(async () => {
            if (outcome?.kind === "escalated") return escalationToolResult(outcome.escalation);
            if (outcome) {
              throw new McpToolError(`Задача ${session.taskNumber} уже принята как выполненная`);
            }
            const combined = combineAbortSignals(request.signal, toolContext.signal);
            const { signal } = combined;
            try {
              const activeAgent = await agentSession.waitForAgent(signal);
              let escalation: EscalatedChangeTask;
              try {
                await verifyTaskEscalation(
                  command,
                  request.workspaceDirectory,
                  gitRoot,
                  session,
                  signal,
                );
                const commit = await options.taskProfiles.recordEscalation({
                  workspaceDirectory: request.workspaceDirectory,
                  changeId: session.changeId,
                  task: { number: session.taskNumber, description: session.taskDescription },
                  reason: input.reason,
                  signal,
                });
                escalationRecorded = true;
                await deliverRootCommit(
                  gitRoot,
                  session.changeId,
                  session.baselineCommit,
                  commit,
                  signal,
                  command,
                );
                escalation = {
                  changeId: session.changeId,
                  taskId: session.taskId,
                  taskNumber: session.taskNumber,
                  reason: input.reason,
                  commit,
                };
              } catch (error) {
                if (
                  error instanceof ChangeTaskExecutionError ||
                  error instanceof TaskProfilesError ||
                  error instanceof RootBranchDeliveryError
                ) {
                  logger.warn("[OpenSpec] Отклонена эскалация OpenSpec-задачи", {
                    changeId: session.changeId,
                    taskNumber: session.taskNumber,
                    reason: error.message,
                  });
                  throw new McpToolError(error.message);
                }
                if (signal.aborted) throw error;
                logger.error("[OpenSpec] Не удалось эскалировать OpenSpec-задачу", {
                  changeId: session.changeId,
                  taskNumber: session.taskNumber,
                  code: errorCode(error),
                });
                throw new McpToolError("Не удалось эскалировать OpenSpec-задачу");
              }

              try {
                await agentSession.disableNotifications(signal);
              } catch (error) {
                if (signal.aborted) throw error;
                logger.error("[OpenSpec] Не удалось отключить ntfy task-агента", {
                  agentId: activeAgent.id,
                  code: errorCode(error),
                });
                throw new McpToolError(
                  "Не удалось отключить финальное уведомление агента; повторите вызов",
                );
              }

              try {
                await request.onTaskEscalated(escalation);
              } catch (error) {
                logger.error("[OpenSpec] Не удалось сохранить эскалацию задачи", {
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
                  "Не удалось надёжно сохранить эскалацию задачи; повторите вызов",
                );
              }

              outcome = { kind: "escalated", escalation };
              agentSession.complete(outcome);
              return escalationToolResult(escalation);
            } finally {
              combined.dispose();
            }
          }),
      });

      // Сильнейший профиль и восстановление готового коммита передавать некому.
      const escalationAvailable =
        session.profile !== ESCALATION_PROFILE && !alreadyCommitted;
      const scope = await agentSession.openScope(() =>
        host.expose(
          escalationAvailable
            ? { [COMPLETION_TOOL]: completionTool, [ESCALATION_TOOL]: escalationTool }
            : { [COMPLETION_TOOL]: completionTool },
        ),
      );

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
            alreadyCommitted,
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
    ? "This is a recovery session: the selected task is already implemented and committed. Do not invoke the apply skill, change files, or create or amend another commit; call the completion tool."
    : `Invoke exactly this skill command as the implementation request:

\`$openspec-apply-change ${session.changeId} Выполни задачу ${session.taskNumber}. К другим задачам не приступай.\`

Stop the apply loop right after task ${session.taskNumber}: implement its full specified behavior, run the relevant verification, and mark only its checkbox complete. Leave the description, numbering, order, and completion state of every other task unchanged.`;
  const commitInstruction = input.alreadyCommitted
    ? ""
    : `When implementation and verification are complete, commit the files task ${session.taskNumber} needed in at least one commit after the baseline.`;
  const escalatedInstruction = input.alreadyCommitted || session.escalationReason === null
    ? ""
    : "A session on a weaker profile already worked on this task and escalated it to you for the reason in `escalationReason`. It may have committed partial work before escalating: inspect the recent commits of the branch and keep, fix, or revert that work with new commits.";
  const escalationInstruction = input.alreadyCommitted || session.profile === ESCALATION_PROFILE
    ? ""
    : `You run on the ${session.profile} profile. If the task turns out to need stronger reasoning than you can reliably provide, do not guess: escalate it to the ${ESCALATION_PROFILE} profile by calling the orchestrator MCP tool \`${ESCALATION_TOOL}\` with \`reason\`, one Russian sentence naming the obstacle. Escalate only for an objective obstacle, for example: a failure whose cause stays unclear after several focused attempts, specs or artifacts that contradict the code, a design decision the artifacts leave open, or a change that reaches far beyond what the task describes. Never escalate merely because the task is large or tedious. Before escalating, leave the worktree clean: commit partial work that is correct and worth keeping, discard the rest, and never mark the task complete. After the escalation succeeds, end the turn silently; the orchestrator reruns the task on the ${ESCALATION_PROFILE} profile, which sees your commits.`;

  return buildAgentPrompt({
    role: "You own exactly one OpenSpec implementation task.",
    communication: "blocker-only",
    verification: { kind: input.alreadyCommitted ? "no-code" : "code" },
    workflowData: {
      changeId: session.changeId,
      taskNumber: session.taskNumber,
      taskDescription: session.taskDescription,
      profile: session.profile,
      ...(session.escalationReason === null ? {} : { escalationReason: session.escalationReason }),
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
      OPENSPEC_CLI_RULE,
      NO_GITHUB_RULE,
      FIXED_BRANCH_RULE,
      STAGE_SCOPE_RULE,
    ],
    body: [
      escalatedInstruction,
      applyInstruction,
      commitInstruction,
      escalationInstruction,
      "Do not push. The orchestrator verifies and publishes the task commits to the root branch.",
    ],
    completion: completionInstruction({
      tool: "complete_change_task",
      retryScope: "this task's commits or push state",
      afterSuccess:
        "After it succeeds, end the turn silently instead of sending another message.",
    }),
  });
}

function escalationToolResult(escalation: EscalatedChangeTask): {
  readonly text: string;
  readonly data: z.input<typeof escalationOutputSchema>;
} {
  return {
    text: `${escalatedToolMessage(escalation)}; workflow запустит её заново`,
    data: {
      changeId: escalation.changeId,
      taskNumber: escalation.taskNumber,
      profile: ESCALATION_PROFILE,
      commit: escalation.commit,
    },
  };
}

function escalatedToolMessage(escalation: EscalatedChangeTask): string {
  return `Задача ${escalation.taskNumber} передана профилю ${ESCALATION_PROFILE}`;
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
