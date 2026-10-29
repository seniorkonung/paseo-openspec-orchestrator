import type { lstat } from "node:fs/promises";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { CompleteRequiredAgentProfile } from "./agent-profiles.ts";
import {
  FIXED_BRANCH_RULE,
  NO_GITHUB_RULE,
  OPENSPEC_CLI_RULE,
  STAGE_SCOPE_RULE,
  TASK_ORDER_FACT,
  buildAgentPrompt,
  completionInstruction,
} from "./agent-prompt.ts";
import { combineAbortSignals, throwIfSignalAborted } from "./agent-session-control.ts";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { changeBranchFor, changeBranchSchema } from "./change-branch.ts";
import {
  assertCleanTaskWorktree,
  readCurrentTaskBranch,
  readTaskChangedPaths,
  readTaskHeadCommit,
} from "./change-task-gateway.ts";
import {
  ChangeTaskExecutionError,
  MAX_TASKS,
  taskDescriptionSchema,
  taskNumberSchema,
} from "./change-task-model.ts";
import { readNumberedChangeTasks } from "./change-task-publication.ts";
import { isCommitAncestor } from "./git-ancestry.ts";
import type { ImplementationRun } from "./implementation-run-model.ts";
import { createManagedAgentSession, type AgentResourceReleaser } from "./managed-agent-session.ts";
import {
  McpToolError,
  OrchestratorMcpToolHost,
  defineMcpTool,
} from "./orchestrator-mcp-tool-host.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  updateAgentNotificationLabel,
  type AgentNotificationLabelUpdater,
} from "./paseo-agent-labels.ts";
import { readRepoLocalChangePaths, type RepoLocalChangePaths } from "./repo-local-change.ts";
import { deliverRootCommit, RootBranchDeliveryError } from "./root-branch-delivery.ts";
import { RESUMABLE_SESSION, staleSession, type SessionAssessment } from "./session-assessment.ts";
import {
  commitTaskProfiles,
  readTaskProfilesAt,
  taskProfilesRepositoryPath,
} from "./task-profile-git.ts";
import { ESCALATION_PROFILE } from "./task-profile-level.ts";
import {
  TaskProfilesError,
  assertProfileTaskHeadings,
  bindTaskProfiles,
  escalateTaskProfile,
  mergeTaskProfiles,
  recordForTask,
  sameTaskProfiles,
  summarizeTaskProfiles,
  taskProfilesInputSchema,
  unassessedTasks,
  type ProfileTask,
  type TaskProfileRecord,
} from "./task-profile-model.ts";

type PaseoApi = PluginHandlerContext["paseo"];
type PaseoWorkspace = ReturnType<PaseoApi["workspaces"]["ref"]>;
type PaseoAgent = Awaited<ReturnType<PaseoWorkspace["agents"]["create"]>>;

export type TaskProfilePaseoAgentCreator = (
  options: Parameters<PaseoWorkspace["agents"]["create"]>[0],
) => Promise<PaseoAgent>;

const DEFAULT_AGENT_DRAIN_TIMEOUT_MS = 15_000;
const ASSESSMENT_TOOL = "submit_task_profiles";

const profileTaskSchema = z
  .object({ number: taskNumberSchema, description: taskDescriptionSchema })
  .strict();

/**
 * Сессия оценки профилей: незавершённые задачи фазы без действующей оценки на
 * момент baseline. Оценки записывает оркестратор одним коммитом файла профилей.
 */
export const pendingTaskProfileAssessmentSessionSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    branch: changeBranchSchema,
    phaseNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    baselineCommit: commitHashSchema,
    tasks: z.array(profileTaskSchema).min(1).max(MAX_TASKS),
  })
  .strict()
  .superRefine((session, context) => {
    if (session.branch !== changeBranchFor(session.changeId)) {
      context.addIssue({
        code: "custom",
        path: ["branch"],
        message: "Ветка оценки профилей не соответствует change",
      });
    }
    const numbers = session.tasks.map(({ number }) => number);
    if (new Set(numbers).size !== numbers.length) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "Сессия оценки профилей содержит повторяющиеся задачи",
      });
    }
    if (numbers.some((number) => Number(number.split(".")[0]) !== session.phaseNumber)) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "Сессия оценки профилей содержит задачи другой фазы",
      });
    }
  });

export type PendingTaskProfileAssessmentSession = z.infer<
  typeof pendingTaskProfileAssessmentSessionSchema
>;

/**
 * Профили незавершённых задач фазы.
 *
 * - `assessed` — у каждой незавершённой задачи фазы есть действующая оценка;
 * - `assessment-required` — задачи без оценки нужно оценить до выполнения
 *   любой задачи фазы.
 */
export type TaskProfileInspection =
  | { readonly kind: "assessed"; readonly records: readonly TaskProfileRecord[] }
  | {
      readonly kind: "assessment-required";
      readonly session: PendingTaskProfileAssessmentSession;
    };

export interface RecordedTaskProfiles {
  readonly changeId: string;
  readonly phaseNumber: number;
  readonly commit: string;
  /** Оценки задач сессии в порядке исполнения. */
  readonly records: readonly TaskProfileRecord[];
}

export interface TaskProfileAssessmentRequest {
  readonly workspaceDirectory: string;
  readonly profile: CompleteRequiredAgentProfile;
  readonly session: PendingTaskProfileAssessmentSession;
  readonly signal: AbortSignal;
  readonly onAgentCreated: (agentId: string) => void;
  readonly onProfilesRecorded: (recorded: RecordedTaskProfiles) => Promise<void>;
}

export interface TaskEscalationRequest {
  readonly workspaceDirectory: string;
  readonly changeId: string;
  readonly task: ProfileTask;
  readonly reason: string;
  readonly signal: AbortSignal;
}

export interface TaskProfileService {
  /** Читает профили незавершённых задач фазы run на текущем HEAD. */
  inspect(
    workspaceDirectory: string,
    run: ImplementationRun,
    signal?: AbortSignal,
  ): Promise<TaskProfileInspection>;
  /**
   * Сессия продолжается, пока оценки ещё не записаны либо уже записаны
   * проверяемым коммитом файла профилей. Она устарела, когда HEAD не
   * продолжает baseline или после него появились другие изменения.
   */
  assess(
    workspaceDirectory: string,
    session: PendingTaskProfileAssessmentSession,
    signal: AbortSignal,
  ): Promise<SessionAssessment>;
  /** Получает оценки от High-агента, коммитит файл профилей и публикует коммит. */
  run(request: TaskProfileAssessmentRequest): Promise<RecordedTaskProfiles>;
  /**
   * Записывает эскалацию задачи одним коммитом файла профилей и возвращает
   * его. Если эскалация уже записана, возвращает текущий HEAD без нового
   * коммита. Публикует коммит вызывающий: он отвечает и за коммиты агента.
   */
  recordEscalation(request: TaskEscalationRequest): Promise<string>;
}

interface McpHostFactory {
  listen(): Promise<OrchestratorMcpToolHost>;
}

export interface TaskProfileServiceOptions {
  readonly createAgent: TaskProfilePaseoAgentCreator;
  readonly releaseAgent?: AgentResourceReleaser;
  readonly command?: BoundedCommandRunner;
  readonly updateNotificationLabel?: AgentNotificationLabelUpdater;
  readonly mcpHost?: McpHostFactory;
  readonly agentDrainTimeoutMs?: number;
  readonly logger?: Pick<Console, "error" | "warn">;
  readonly inspectPath?: typeof lstat;
}

type AssessmentSessionState =
  | { readonly kind: "pending" }
  | { readonly kind: "recorded"; readonly recorded: RecordedTaskProfiles }
  | { readonly kind: "stale"; readonly reason: string };

const recordedProfilesOutputSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    commit: commitHashSchema,
    profiles: z.string().max(65_536),
  })
  .strict();

export function createTaskProfileService(options: TaskProfileServiceOptions): TaskProfileService {
  const command = options.command ?? runBoundedCommand;
  const updateNotificationLabel = options.updateNotificationLabel ?? updateAgentNotificationLabel;
  const mcpHost = options.mcpHost ?? OrchestratorMcpToolHost;
  const agentDrainTimeoutMs = options.agentDrainTimeoutMs ?? DEFAULT_AGENT_DRAIN_TIMEOUT_MS;
  const logger = options.logger ?? console;
  const inspectPathOption = options.inspectPath === undefined ? {} : { inspectPath: options.inspectPath };

  const readPaths = (
    workspaceDirectory: string,
    changeId: string,
    signal?: AbortSignal,
  ): Promise<RepoLocalChangePaths> =>
    readRepoLocalChangePaths(
      command,
      workspaceDirectory,
      changeId,
      (message) => new TaskProfilesError(message),
      signal,
    );

  const assertBranch = async (
    paths: RepoLocalChangePaths,
    branch: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const current = await readCurrentTaskBranch(command, paths.gitRoot, signal);
    if (current !== branch) {
      throw new TaskProfilesError(`Текущей должна быть корневая ветка «${branch}»`);
    }
  };

  /**
   * Диапазон после baseline подтверждает сессию, только когда он меняет один
   * файл профилей и тот содержит оценку каждой задачи сессии. Так принимаются
   * и оценки, которые пользователь записал сам.
   */
  const inspectSession = async (
    paths: RepoLocalChangePaths,
    session: PendingTaskProfileAssessmentSession,
    signal: AbortSignal,
  ): Promise<AssessmentSessionState> => {
    await assertBranch(paths, session.branch, signal);
    if (!(await isCommitAncestor(command, paths.gitRoot, session.baselineCommit, "HEAD", signal))) {
      return { kind: "stale", reason: "Текущий Git HEAD больше не продолжает baseline оценки профилей" };
    }
    const head = await readTaskHeadCommit(command, paths.gitRoot, signal);
    if (head === session.baselineCommit) return { kind: "pending" };
    // Незакоммиченные правки не делают сессию устаревшей: о них сообщает шаг.
    await assertCleanTaskWorktree(command, paths.gitRoot, signal);
    const profilesPath = taskProfilesRepositoryPath(paths.changeRepositoryPath);
    const changedPaths = await readTaskChangedPaths(
      command,
      paths.gitRoot,
      session.baselineCommit,
      head,
      signal,
    );
    if (changedPaths.length !== 1 || changedPaths[0] !== profilesPath) {
      return {
        kind: "stale",
        reason: `После начала оценки профилей изменены файлы, кроме ${profilesPath}`,
      };
    }
    let records: readonly TaskProfileRecord[];
    try {
      records = await readTaskProfilesAt(command, paths, head, signal);
    } catch (error) {
      if (error instanceof TaskProfilesError) return { kind: "stale", reason: error.message };
      throw error;
    }
    const sessionRecords = session.tasks.map((task) => recordForTask(records, task));
    const missing = session.tasks.filter((_task, index) => sessionRecords[index] === null);
    if (missing.length > 0) {
      return {
        kind: "stale",
        reason: `${profilesPath} не содержит оценки задач ${missing.map(({ number }) => number).join(", ")}`,
      };
    }
    return {
      kind: "recorded",
      recorded: {
        changeId: session.changeId,
        phaseNumber: session.phaseNumber,
        commit: head,
        records: Object.freeze(sessionRecords.filter((record) => record !== null)),
      },
    };
  };

  const deliver = (
    paths: RepoLocalChangePaths,
    session: PendingTaskProfileAssessmentSession,
    recorded: RecordedTaskProfiles,
    signal: AbortSignal,
  ): Promise<void> =>
    deliverRootCommit(
      paths.gitRoot,
      session.changeId,
      session.baselineCommit,
      recorded.commit,
      signal,
      command,
    );

  return {
    async inspect(workspaceDirectory, run, signal) {
      const paths = await readPaths(workspaceDirectory, run.changeId, signal);
      await assertBranch(paths, run.changeBranch, signal);
      await assertCleanTaskWorktree(command, paths.gitRoot, signal);
      const head = await readTaskHeadCommit(command, paths.gitRoot, signal);
      const tasks = (await readNumberedChangeTasks(command, workspaceDirectory, run.changeId, signal))
        .filter(({ task, phaseNumber }) => phaseNumber === run.phaseNumber && !task.done)
        .map(({ task, number }): ProfileTask => ({ number, description: task.description }));
      const records = await readTaskProfilesAt(command, paths, head, signal);
      const unassessed = unassessedTasks(tasks, records);
      if (unassessed.length === 0) return { kind: "assessed", records };
      // Описание задачи агент оценки исправить не может: проверяем до его запуска.
      assertProfileTaskHeadings(unassessed);
      return {
        kind: "assessment-required",
        session: pendingTaskProfileAssessmentSessionSchema.parse({
          changeId: run.changeId,
          branch: run.changeBranch,
          phaseNumber: run.phaseNumber,
          baselineCommit: head,
          tasks: unassessed,
        }),
      };
    },

    async assess(workspaceDirectory, sessionInput, signal) {
      const session = pendingTaskProfileAssessmentSessionSchema.parse(sessionInput);
      const paths = await readPaths(workspaceDirectory, session.changeId, signal);
      const state = await inspectSession(paths, session, signal);
      return state.kind === "stale" ? staleSession(state.reason) : RESUMABLE_SESSION;
    },

    async run(request) {
      throwIfSignalAborted(request.signal);
      const session = pendingTaskProfileAssessmentSessionSchema.parse(request.session);
      const paths = await readPaths(request.workspaceDirectory, session.changeId, request.signal);
      const initial = await inspectSession(paths, session, request.signal);
      if (initial.kind === "stale") throw new TaskProfilesError(initial.reason);
      if (initial.kind === "recorded") {
        // Оценки уже закоммичены: агент не нужен, остаётся публикация.
        await deliver(paths, session, initial.recorded, request.signal);
        await request.onProfilesRecorded(initial.recorded);
        return initial.recorded;
      }

      await assertCleanTaskWorktree(command, paths.gitRoot, request.signal);
      const baselineRecords = await readTaskProfilesAt(
        command,
        paths,
        session.baselineCommit,
        request.signal,
      );

      const host = await mcpHost.listen();
      let completed: RecordedTaskProfiles | null = null;
      const agentSession = createManagedAgentSession<RecordedTaskProfiles>({
        signal: request.signal,
        releaseAgent: options.releaseAgent,
        host,
        updateNotificationLabel,
        agentDrainTimeoutMs,
        logContext: "оценка профилей OpenSpec-задач",
        logger,
      });

      const tool = defineMcpTool({
        description: "Записать профили агентов для оцениваемых OpenSpec-задач фазы",
        inputSchema: taskProfilesInputSchema,
        outputSchema: recordedProfilesOutputSchema,
        execute: (input, toolContext) =>
          agentSession.runExclusive(async () => {
            if (completed) return profilesToolResult(completed);
            const combined = combineAbortSignals(request.signal, toolContext.signal);
            const { signal } = combined;
            try {
              const activeAgent = await agentSession.waitForAgent(signal);
              let recorded: RecordedTaskProfiles;
              let replacedByRepository = false;
              try {
                const assessed = bindTaskProfiles(session.tasks, input);
                const state = await inspectSession(paths, session, signal);
                if (state.kind === "stale") throw new TaskProfilesError(state.reason);
                if (state.kind === "recorded") {
                  // Коммит уже есть: повторный вызов после сбоя публикации либо
                  // профили, которые записал пользователь. Действует репозиторий.
                  recorded = state.recorded;
                  replacedByRepository = !sameTaskProfiles(state.recorded.records, assessed);
                } else {
                  try {
                    await assertCleanTaskWorktree(command, paths.gitRoot, signal);
                  } catch (error) {
                    if (error instanceof ChangeTaskExecutionError) {
                      throw new TaskProfilesError(
                        "Сессия оценки не должна менять файлы: верните рабочее дерево в исходное состояние",
                      );
                    }
                    throw error;
                  }
                  await commitTaskProfiles({
                    command,
                    paths,
                    records: mergeTaskProfiles(baselineRecords, assessed),
                    subject: `docs(openspec): assess task profiles for phase ${session.phaseNumber}`,
                    signal,
                    ...inspectPathOption,
                  });
                  const written = await inspectSession(paths, session, signal);
                  if (written.kind !== "recorded") {
                    throw new TaskProfilesError(
                      written.kind === "stale"
                        ? written.reason
                        : "Коммит профилей не появился в Git HEAD",
                    );
                  }
                  recorded = written.recorded;
                }
                await deliver(paths, session, recorded, signal);
              } catch (error) {
                if (
                  error instanceof TaskProfilesError ||
                  error instanceof ChangeTaskExecutionError ||
                  error instanceof RootBranchDeliveryError
                ) {
                  logger.warn("[OpenSpec] Отклонены профили OpenSpec-задач", {
                    changeId: session.changeId,
                    reason: error.message,
                  });
                  throw new McpToolError(error.message);
                }
                if (signal.aborted) throw error;
                logger.error("[OpenSpec] Не удалось записать профили OpenSpec-задач", {
                  changeId: session.changeId,
                  code: errorCode(error),
                });
                throw new McpToolError("Не удалось записать профили OpenSpec-задач");
              }

              try {
                await agentSession.disableNotifications(signal);
              } catch (error) {
                if (signal.aborted) throw error;
                logger.error("[OpenSpec] Не удалось отключить ntfy агента оценки профилей", {
                  agentId: activeAgent.id,
                  code: errorCode(error),
                });
                throw new McpToolError(
                  "Не удалось отключить финальное уведомление агента; повторите вызов",
                );
              }

              try {
                await request.onProfilesRecorded(recorded);
              } catch (error) {
                logger.error("[OpenSpec] Не удалось сохранить профили OpenSpec-задач", {
                  changeId: session.changeId,
                  code: errorCode(error),
                });
                try {
                  await agentSession.restoreNotifications(request.signal);
                } catch (restoreError) {
                  logger.warn("[OpenSpec] Не удалось восстановить ntfy агента оценки профилей", {
                    agentId: activeAgent.id,
                    code: errorCode(restoreError),
                  });
                }
                throw new McpToolError(
                  "Не удалось надёжно сохранить профили OpenSpec-задач; повторите вызов",
                );
              }

              completed = recorded;
              agentSession.complete(recorded);
              const result = profilesToolResult(recorded);
              return replacedByRepository
                ? {
                    ...result,
                    text: `Профили задач уже записаны в репозитории коммитом ${recorded.commit} и приняты вместо переданных: ${result.data.profiles}`,
                  }
                : result;
            } finally {
              combined.dispose();
            }
          }),
      });
      const scope = await agentSession.openScope(() => host.expose({ [ASSESSMENT_TOOL]: tool }));

      try {
        const config = scope.configureAgent({
          provider: `${request.profile.provider}/${request.profile.model}`,
          modeId: request.profile.modeId,
          thinkingOptionId: request.profile.thinkingOptionId,
          ...(request.profile.featureValues == null
            ? {}
            : { featureValues: request.profile.featureValues }),
        });
        await agentSession.launchAgent(
          () =>
            options.createAgent({
              config,
              title: `Профили задач Phase ${session.phaseNumber}: ${session.changeId}`,
              prompt: taskProfileAssessmentPrompt({
                session,
                changeRepositoryPath: paths.changeRepositoryPath,
              }),
              labels: { ntfy: "true" },
            }),
          request.onAgentCreated,
        );

        const recorded = await agentSession.waitForCompletion();
        await new Promise<void>((resolveDrain) => setImmediate(resolveDrain));
        await agentSession.drainAgent();
        return recorded;
      } finally {
        await agentSession.close();
      }
    },

    async recordEscalation(request) {
      const paths = await readPaths(request.workspaceDirectory, request.changeId, request.signal);
      await assertBranch(paths, changeBranchFor(request.changeId), request.signal);
      await assertCleanTaskWorktree(command, paths.gitRoot, request.signal);
      const head = await readTaskHeadCommit(command, paths.gitRoot, request.signal);
      const records = await readTaskProfilesAt(command, paths, head, request.signal);
      // Повторный вызов после сбоя публикации: эскалация уже закоммичена.
      if (recordForTask(records, request.task)?.assignment.kind === "escalated") return head;
      return commitTaskProfiles({
        command,
        paths,
        records: escalateTaskProfile(records, request.task, request.reason),
        subject: `docs(openspec): escalate task ${request.task.number} to ${ESCALATION_PROFILE}`,
        signal: request.signal,
        ...inspectPathOption,
      });
    },
  };
}

export function taskProfileAssessmentPrompt(input: {
  readonly session: PendingTaskProfileAssessmentSession;
  readonly changeRepositoryPath: string;
}): string {
  const { session } = input;
  return buildAgentPrompt({
    role: `You assign the agent profile that will execute each listed OpenSpec task of Phase ${session.phaseNumber}.`,
    communication: "blocker-only",
    verification: { kind: "no-code" },
    workflowData: {
      changeId: session.changeId,
      phaseNumber: session.phaseNumber,
      changeDirectory: input.changeRepositoryPath,
      profilesFile: taskProfilesRepositoryPath(input.changeRepositoryPath),
      tasks: session.tasks,
    },
    rules: [
      OPENSPEC_CLI_RULE,
      NO_GITHUB_RULE,
      FIXED_BRANCH_RULE,
      STAGE_SCOPE_RULE,
      "This session is read-only: never change files or create commits, because the orchestrator records your assessment in the profiles file.",
    ],
    body: [
      `${TASK_ORDER_FACT} Each listed task runs in its own autonomous session on the profile you assign, after every task before it is complete. Before deciding, read the change artifacts (proposal, design, specs, plan.md, and tasks) and inspect the code each task touches. Assess every listed task; profiles already in the profiles file belong to other tasks and are not part of this assessment.`,
      "Assign either Medium or High. Both are frontier models of the same provider: High is the strongest and most expensive tier, and Medium is a capable cost-efficient tier, not a model for trivial work only. Decide by who makes the decisions, not by the size or area of the task. Assign Medium when every substantial decision is already made: the specs and design settle the behavior, and the way to implement it is evident from the artifacts or existing code. Medium then executes reliably regardless of size, even in sensitive areas such as concurrency, security, persistence, or recovery. Assign High when the session itself must make a non-trivial decision: choose the approach, resolve ambiguous or conflicting requirements, preserve non-obvious invariants across several components, or find the cause of behavior nobody understands yet. High is the default: assign Medium only when you are confident that the decisions are already made. A Medium session can escalate its task to High when it hits an obstacle, but it may miss its own subtle mistake, so do not rely on escalation to justify Medium.",
      "Write every rationale as one Russian sentence that names the decisive factor.",
    ],
    completion: completionInstruction({
      tool: ASSESSMENT_TOOL,
      argument:
        "`assessments`: exactly one `{ taskNumber, profile, rationale }` entry per listed task, where `profile` is `High` or `Medium`",
      retryScope: "the assessments",
      afterSuccess: "After it succeeds, end the turn silently instead of sending another message.",
    }),
  });
}

function profilesToolResult(recorded: RecordedTaskProfiles): {
  readonly text: string;
  readonly data: z.input<typeof recordedProfilesOutputSchema>;
} {
  const profiles = summarizeTaskProfiles(recorded.records);
  return {
    text: `Профили задач записаны и опубликованы коммитом ${recorded.commit}: ${profiles}`,
    data: { changeId: recorded.changeId, commit: recorded.commit, profiles },
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}
