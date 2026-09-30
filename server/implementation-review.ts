import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { CompleteRequiredAgentProfile } from "./agent-profiles.ts";
import {
  FIXED_BRANCH_RULE,
  NO_GITHUB_RULE,
  OPENSPEC_CLI_RULE,
  buildAgentPrompt,
  completionInstruction,
  taskScopeRule,
  taskScopeWorkflowData,
} from "./agent-prompt.ts";
import { combineAbortSignals, throwIfSignalAborted } from "./agent-session-control.ts";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { applyInstructionsSchema, type ApplyInstructions } from "./change-task-model.ts";
import {
  assertCleanTaskWorktree,
  assertTaskCommitDescendsFrom,
  readCurrentTaskBranch,
  readLocalTaskBranchCommit,
  readRemoteTaskBranchCommit,
  readTaskChangedPaths,
  readTaskCommitCount,
  readTaskHeadCommit,
  resolveTaskRepository,
} from "./change-task-gateway.ts";
import {
  implementationBranchSchema,
  changeBranchSchema,
  type ImplementationBranch,
} from "./change-branch.ts";
import {
  implementationBatchSchema,
  implementationRepositorySchema,
  implementationRunSchema,
  implementationTaskCommitSchema,
  type ImplementationTaskCommit,
  type ImplementationRun,
} from "./implementation-run-model.ts";
import {
  readImplementationReviewContext,
  type ImplementationReviewContext,
} from "./implementation-review-context.ts";
import {
  ImplementationReviewReportError,
  readImplementationReviewReport,
} from "./implementation-review-report.ts";
import { deliverRootCommit } from "./root-branch-delivery.ts";
import { createRootPullRequestService } from "./root-pull-request.ts";
import { readReviewPullRequest } from "./review-publication-gateway.ts";
import { repositoryArgument } from "./review-publication-model.ts";
import { createManagedAgentSession } from "./managed-agent-session.ts";
import { McpToolError, OrchestratorMcpToolHost, defineMcpTool } from "./orchestrator-mcp-tool-host.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import { runWorkspaceMiseCommand } from "./mise-toolchain.ts";
import {
  createTaskScopeCheck,
  phaseProgressSchema,
  type PhaseProgress,
  type PhaseWorkService,
  type TaskScopeCheck,
} from "./phase-work.ts";
import { updateAgentNotificationLabel, type AgentNotificationLabelUpdater } from "./paseo-agent-labels.ts";
import { ChangeReviewPublicationError } from "./review-publication-model.ts";

const REVIEW_SKILL = "openspec-review-implementation";
const DEFAULT_AGENT_DRAIN_TIMEOUT_MS = 15_000;
const REVIEW_STAGE_SCOPE_RULE =
  "Stay inside this stage: never create or archive workspaces or changes, and never invoke another workflow.";

export const pendingImplementationReviewSessionSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    changeBranch: changeBranchSchema,
    implementationBranch: implementationBranchSchema,
    rootBaselineCommit: commitHashSchema,
    baseCommit: commitHashSchema,
    reviewedHead: commitHashSchema,
    tasks: z.array(implementationTaskCommitSchema).min(1).max(4_096),
    repository: implementationRepositorySchema,
  })
  .strict();

export type PendingImplementationReviewSession = z.infer<
  typeof pendingImplementationReviewSessionSchema
>;

export interface CompletedImplementationReview {
  readonly changeId: string;
  readonly branch: ImplementationBranch;
  readonly baseCommit: string;
  readonly reviewedHead: string;
  readonly reviewCommit: string;
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
    readonly title: string;
  };
}

export interface ImplementationReviewService {
  plan(
    workspaceDirectory: string,
    run: ImplementationRun,
    signal?: AbortSignal,
  ): Promise<PendingImplementationReviewSession>;
  run(request: {
    readonly workspaceDirectory: string;
    readonly profile: CompleteRequiredAgentProfile;
    readonly run: ImplementationRun;
    readonly session: PendingImplementationReviewSession;
    /** Известная история задач run: review добавляет задачи только в свою фазу или новую фазу после неё. */
    readonly taskBaseline: PhaseProgress;
    readonly signal: AbortSignal;
    readonly onAgentCreated: (agentId: string) => void;
    readonly onReviewCompleted: (review: CompletedImplementationReview) => Promise<void>;
  }): Promise<CompletedImplementationReview>;
}

type PaseoApi = PluginHandlerContext["paseo"];
type PaseoWorkspace = ReturnType<PaseoApi["workspaces"]["ref"]>;
type PaseoAgent = Awaited<ReturnType<PaseoWorkspace["agents"]["create"]>>;

export interface ImplementationReviewServiceOptions {
  readonly createAgent: (
    options: Parameters<PaseoWorkspace["agents"]["create"]>[0],
  ) => Promise<PaseoAgent>;
  readonly phaseWork: Pick<PhaseWorkService, "inspect">;
  readonly command?: BoundedCommandRunner;
  readonly updateNotificationLabel?: AgentNotificationLabelUpdater;
  readonly mcpHost?: { listen(): Promise<OrchestratorMcpToolHost> };
  readonly agentDrainTimeoutMs?: number;
  readonly logger?: Pick<Console, "error" | "warn">;
}

export class ImplementationReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImplementationReviewError";
  }
}

export function createImplementationReviewService(
  options: ImplementationReviewServiceOptions,
): ImplementationReviewService {
  const command = options.command ?? runBoundedCommand;
  const rootPullRequest = createRootPullRequestService({ command });
  const updateNotificationLabel = options.updateNotificationLabel ?? updateAgentNotificationLabel;
  const mcpHost = options.mcpHost ?? OrchestratorMcpToolHost;
  const agentDrainTimeoutMs = options.agentDrainTimeoutMs ?? DEFAULT_AGENT_DRAIN_TIMEOUT_MS;
  const logger = options.logger ?? console;

  return {
    async plan(workspaceDirectory, runInput, signal) {
      const run = implementationRunSchema.parse(runInput);
      if (run.batch.kind !== "collecting") {
        throw new ImplementationReviewError(
          "Implementation review требует непустой collecting-пакет",
        );
      }
      await assertImplementationState(command, workspaceDirectory, run, run.batch.headCommit, signal);
      await assertTaskCommitDescendsFrom(
        command,
        workspaceDirectory,
        run.batch.baseCommit,
        run.batch.headCommit,
        "Task-пакет не продолжает сохранённый batch baseline",
        signal,
      );
      const commits = await readCommitRange(
        command,
        workspaceDirectory,
        run.batch.baseCommit,
        run.batch.headCommit,
        signal,
      );
      assertTaskCommitCoverage(commits, run.batch.tasks);
      return pendingImplementationReviewSessionSchema.parse({
        changeId: run.changeId,
        changeBranch: run.changeBranch,
        implementationBranch: run.implementationBranch,
        rootBaselineCommit: run.rootBaselineCommit,
        baseCommit: run.batch.baseCommit,
        reviewedHead: run.batch.headCommit,
        tasks: run.batch.tasks,
        repository: run.repository,
      });
    },

    async run(request) {
      throwIfSignalAborted(request.signal);
      const run = implementationRunSchema.parse(request.run);
      const session = pendingImplementationReviewSessionSchema.parse(request.session);
      assertSessionMatchesRun(session, run);
      const context = await readImplementationReviewContext(
        command,
        request.workspaceDirectory,
        session.changeId,
        (message) => new ImplementationReviewError(message),
        request.signal,
      );
      const assertTaskScope = createTaskScopeCheck(
        options.phaseWork,
        request.workspaceDirectory,
        session.changeId,
        {
          kind: "implementation",
          phaseNumber: run.phaseNumber,
          baseline: phaseProgressSchema.parse(request.taskBaseline),
        },
        (message) => new ImplementationReviewError(message),
      );
      const alreadyCommitted = await inspectExistingReviewCommit(
        command,
        context,
        session,
        assertTaskScope,
        request.signal,
      );
      const targetCommits = await readCommitRange(
        command,
        context.gitRoot,
        session.baseCommit,
        session.reviewedHead,
        request.signal,
      );
      assertTaskCommitCoverage(targetCommits, session.tasks);
      const host = await mcpHost.listen();
      let completed: CompletedImplementationReview | null = null;
      const agentSession = createManagedAgentSession<CompletedImplementationReview>({
        signal: request.signal,
        host,
        updateNotificationLabel,
        agentDrainTimeoutMs,
        logContext: "implementation review",
        logger,
      });
      const outputSchema = z
        .object({
          changeId: openSpecChangeIdSchema,
          branch: implementationBranchSchema,
          baseCommit: commitHashSchema,
          reviewedHead: commitHashSchema,
          reviewCommit: commitHashSchema,
          pullRequest: z
            .object({
              number: z.number().int().positive(),
              url: z.string().url().max(2_048),
              title: z.string().trim().min(1).max(256),
            })
            .strict(),
        })
        .strict();
      const scope = await agentSession.openScope(() => host.expose({
        complete_implementation_review: defineMcpTool({
          description:
            "Проверить точный implementation-диапазон и опубликовать review-коммит в корневом Draft PR",
          inputSchema: z.object({}).strict(),
          outputSchema,
          execute: (_input, toolContext) => agentSession.runExclusive(async () => {
            if (completed) return completionResult(completed);
            const combined = combineAbortSignals(request.signal, toolContext.signal);
            try {
              const activeAgent = await agentSession.waitForAgent(combined.signal);
              let verified: CompletedImplementationReview;
              try {
                const local = await verifyCompletedReview(
                  command,
                  context,
                  session,
                  assertTaskScope,
                  combined.signal,
                );
                await deliverRootCommit(
                  context.gitRoot,
                  session.changeId,
                  session.reviewedHead,
                  local.reviewCommit,
                  combined.signal,
                  command,
                );
                const pullRequest = await rootPullRequest.inspect(
                  context.gitRoot,
                  session.changeId,
                  session.changeBranch,
                  null,
                  combined.signal,
                );
                if (pullRequest.kind !== "open" || !pullRequest.isDraft) {
                  throw new ImplementationReviewError("Корневой PR должен оставаться Draft во время review");
                }
                const fullPullRequest = await readReviewPullRequest(
                  command,
                  context.gitRoot,
                  repositoryArgument(run.repository),
                  pullRequest.identity.number,
                  combined.signal,
                );
                verified = {
                  ...local,
                  pullRequest: {
                    number: pullRequest.identity.number,
                    url: pullRequest.identity.url,
                    title: fullPullRequest.title,
                  },
                };
              } catch (error) {
                if (
                  error instanceof ImplementationReviewError ||
                  error instanceof ChangeReviewPublicationError
                ) {
                  throw new McpToolError(error.message);
                }
                if (combined.signal.aborted) throw error;
                logger.error("[OpenSpec] Не удалось проверить implementation review", {
                  changeId: session.changeId,
                  code: errorCode(error),
                });
                throw new McpToolError("Не удалось проверить implementation review");
              }
              await agentSession.disableNotifications(combined.signal).catch((error) => {
                if (combined.signal.aborted) throw error;
                throw new McpToolError(
                  `Не удалось отключить финальное уведомление агента ${activeAgent.id}`,
                );
              });
              try {
                await request.onReviewCompleted(verified);
              } catch (error) {
                try {
                  await agentSession.restoreNotifications(combined.signal);
                } catch (restoreError) {
                  logger.warn("[OpenSpec] Не удалось восстановить ntfy review-агента", {
                    code: errorCode(restoreError),
                  });
                }
                throw new McpToolError(
                  "Не удалось надёжно сохранить implementation review; повторите вызов",
                );
              }
              completed = verified;
              agentSession.complete(verified);
              return completionResult(verified);
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
          () => options.createAgent({
            config,
            title: `Review implementation: ${session.changeId}`,
            labels: { ntfy: "true" },
          }),
          request.onAgentCreated,
        );
        const catalog = await agent.commands();
        const commands = new Set(catalog.commands.map(({ name }) => name));
        if (catalog.error || !commands.has(REVIEW_SKILL)) {
          throw new ImplementationReviewError(
            `Агент не загрузил обязательный skill ${REVIEW_SKILL}`,
          );
        }
        await agent.send(implementationReviewPrompt({
          session,
          phaseNumber: run.phaseNumber,
          reviewRepositoryPath: context.reviewRepositoryPath,
          alreadyCommitted,
          targetCommits,
        }));
        const result = await agentSession.waitForCompletion();
        await new Promise<void>((resolveDrain) => setImmediate(resolveDrain));
        await agentSession.drainAgent();
        return result;
      } finally {
        await agentSession.close();
      }
    },
  };
}

export function implementationReviewPrompt(input: {
  readonly session: PendingImplementationReviewSession;
  /** Фаза implementation run: review добавляет задачи только в неё или в новую фазу после неё. */
  readonly phaseNumber: number;
  readonly reviewRepositoryPath: string;
  readonly alreadyCommitted: boolean;
  readonly targetCommits: readonly string[];
}): string {
  const { session } = input;
  const taskScope = { kind: "implementation", phaseNumber: input.phaseNumber } as const;
  const reviewInstruction = input.alreadyCommitted
    ? "This is a recovery session: the complete report commits already exist. Do not invoke the review skill, edit files, or create or amend a commit."
    : `Invoke \`openspec-review-implementation\` for the exact saved range \`${session.baseCommit}..${session.reviewedHead}\` and change \`${session.changeId}\`. Review every target commit and map every task to at least one review unit.`;
  const delegationInstruction = input.alreadyCommitted
    ? ""
    : `You may spawn review subagents to inspect the exact saved range \`${session.baseCommit}..${session.reviewedHead}\`. Give them the same stage boundaries and target commits from the workflow data. They may only inspect and report findings. Only you may write the report, create the review commit, and call \`complete_implementation_review\`.`;
  const commitInstruction = input.alreadyCommitted
    ? ""
    : "When the report is complete and format-valid, commit the report and all stage corrections in at least one new commit after the reviewed head.";

  return buildAgentPrompt({
    role: "You own one bounded implementation-review stage.",
    communication: "blocker-only",
    workflowData: {
      changeId: session.changeId,
      branch: session.implementationBranch,
      baseCommit: session.baseCommit,
      reviewedHead: session.reviewedHead,
      targetCommits: input.targetCommits,
      tasks: session.tasks,
      taskCommitRanges: session.tasks.map((task, index) => ({
        taskId: task.taskId,
        taskNumber: task.taskNumber,
        fromExclusive: index === 0 ? session.baseCommit : session.tasks[index - 1]!.commit,
        throughInclusive: task.commit,
      })),
      reviewPath: input.reviewRepositoryPath,
      alreadyCommitted: input.alreadyCommitted,
      ...taskScopeWorkflowData(taskScope),
    },
    rules: [
      OPENSPEC_CLI_RULE,
      NO_GITHUB_RULE,
      FIXED_BRANCH_RULE,
      REVIEW_STAGE_SCOPE_RULE,
    ],
    body: [
      reviewInstruction,
      delegationInstruction,
      `The report at \`${input.reviewRepositoryPath}\` needs complete coverage and the exact Base commit, Reviewed head, and ordered Target commits from the workflow data.`,
      input.alreadyCommitted ? "" : `Follow the review skill for any corrections to code or artifacts, verify those corrections in this session, and reflect their outcome in the report. Preserve the workflow's recorded task history: task IDs, numbers, descriptions, and order stay the same, completed tasks stay complete, and new tasks start incomplete. ${taskScopeRule(taskScope)} Record remaining findings for the later finding-resolution stages.`,
      commitInstruction,
      "Do not push or create a pull request. The orchestrator publishes the verified review commit to the root branch.",
    ],
    completion: completionInstruction({
      tool: "complete_implementation_review",
      retryScope: "the review report, stage commits, or their push",
    }),
  });
}

async function inspectExistingReviewCommit(
  command: BoundedCommandRunner,
  context: ImplementationReviewContext,
  session: PendingImplementationReviewSession,
  assertTaskScope: TaskScopeCheck,
  signal: AbortSignal,
): Promise<boolean> {
  await assertSessionRepositoryState(command, context.gitRoot, session, signal);
  const head = await readTaskHeadCommit(command, context.gitRoot, signal);
  if (head === session.reviewedHead) {
    const remoteHead = await readRemoteTaskBranchCommit(
      command,
      context.gitRoot,
      session.implementationBranch,
      signal,
    );
    if (remoteHead !== session.reviewedHead) {
      throw new ImplementationReviewError(
        "Origin корневой ветки не совпадает с reviewed head",
      );
    }
    return false;
  }
  await assertTaskCommitDescendsFrom(
    command, context.gitRoot, session.reviewedHead, head,
    "Implementation review commit не продолжает reviewed head", signal,
  );
  const changedPaths = await readTaskChangedPaths(
    command, context.gitRoot, session.reviewedHead, head, signal,
  );
  if (!changedPaths.includes(context.reviewRepositoryPath)) return false;
  await verifyCompletedReview(command, context, session, assertTaskScope, signal);
  return true;
}

async function verifyCompletedReview(
  command: BoundedCommandRunner,
  context: ImplementationReviewContext,
  session: PendingImplementationReviewSession,
  assertTaskScope: TaskScopeCheck,
  signal: AbortSignal,
): Promise<Omit<CompletedImplementationReview, "pullRequest">> {
  await assertSessionRepositoryState(command, context.gitRoot, session, signal);
  await assertCleanTaskWorktree(command, context.gitRoot, signal);
  const head = await readTaskHeadCommit(command, context.gitRoot, signal);
  await assertTaskCommitDescendsFrom(
    command,
    context.gitRoot,
    session.reviewedHead,
    head,
    "Implementation review commit не продолжает reviewed head",
    signal,
  );
  const commitCount = await readTaskCommitCount(
    command,
    context.gitRoot,
    session.reviewedHead,
    head,
    signal,
  );
  if (commitCount < 1) {
    throw new ImplementationReviewError(
      "После reviewed head требуется хотя бы один новый implementation review commit",
    );
  }
  const changedPaths = await readTaskChangedPaths(
    command,
    context.gitRoot,
    session.reviewedHead,
    head,
    signal,
  );
  if (!changedPaths.includes(context.reviewRepositoryPath)) {
    throw new ImplementationReviewError(
      "Review-коммиты должны добавлять или изменять implementation-review.md",
    );
  }
  try {
    await command("git", ["cat-file", "-e", `${head}:${context.reviewRepositoryPath}`], {
      cwd: context.gitRoot, signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ImplementationReviewError("implementation-review.md не добавлен в текущий Git HEAD");
  }
  try {
    await readImplementationReviewReport({
      reviewPath: context.reviewPath,
      changeRoot: context.changeRoot,
      expectedChangeId: session.changeId,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ImplementationReviewReportError) {
      throw new ImplementationReviewError(error.message);
    }
    throw error;
  }
  await assertReviewedTasksComplete(command, context.gitRoot, session, signal);
  // Проверка до публикации: задача в фазе, которую планирует оркестратор,
  // отменила бы её фокусное планирование.
  await assertTaskScope(signal);
  const remoteHead = await readRemoteTaskBranchCommit(
    command,
    context.gitRoot,
    session.implementationBranch,
    signal,
  );
  if (remoteHead !== session.reviewedHead && remoteHead !== head) {
    throw new ImplementationReviewError(
      "Origin корневой ветки содержит неожиданный commit",
    );
  }
  return {
    changeId: session.changeId,
    branch: session.implementationBranch,
    baseCommit: session.baseCommit,
    reviewedHead: session.reviewedHead,
    reviewCommit: head,
  };
}

async function assertReviewedTasksComplete(
  command: BoundedCommandRunner,
  gitRoot: string,
  session: PendingImplementationReviewSession,
  signal: AbortSignal,
): Promise<void> {
  let instructions: ApplyInstructions;
  try {
    const { stdout } = await runWorkspaceMiseCommand(
      command,
      gitRoot,
      "openspec",
      ["instructions", "apply", "--change", session.changeId, "--json"],
      signal,
    );
    instructions = applyInstructionsSchema.parse(JSON.parse(stdout) as unknown);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ImplementationReviewError("Не удалось проверить выполненные OpenSpec-задачи пакета");
  }
  if (instructions.changeName !== session.changeId) {
    throw new ImplementationReviewError("OpenSpec вернул задачи другого change");
  }
  const tasksById = new Map(instructions.tasks.map((task) => [task.id, task]));
  if (tasksById.size !== instructions.tasks.length) {
    throw new ImplementationReviewError("OpenSpec вернул повторяющиеся ID задач");
  }
  for (const reviewed of session.tasks) {
    const task = tasksById.get(reviewed.taskId);
    if (!task?.done || task.description.split(/\s/u, 1)[0] !== reviewed.taskNumber) {
      throw new ImplementationReviewError(
        `Выполненная задача ${reviewed.taskNumber} удалена, перенумерована или снова открыта во время review`,
      );
    }
  }
}

async function assertImplementationState(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  run: ImplementationRun,
  expectedHead: string,
  signal?: AbortSignal,
): Promise<void> {
  const session = pendingImplementationReviewSessionSchema.parse({
    changeId: run.changeId,
    changeBranch: run.changeBranch,
    implementationBranch: run.implementationBranch,
    rootBaselineCommit: run.rootBaselineCommit,
    baseCommit: run.batch.baseCommit,
    reviewedHead: expectedHead,
    tasks: run.batch.kind === "collecting" ? run.batch.tasks : [],
    repository: run.repository,
  });
  await assertSessionRepositoryState(command, workspaceDirectory, session, signal);
  const [head, remoteHead] = await Promise.all([
    readTaskHeadCommit(command, workspaceDirectory, signal),
    readRemoteTaskBranchCommit(
      command,
      workspaceDirectory,
      run.implementationBranch,
      signal,
    ),
  ]);
  if (head !== expectedHead) {
    throw new ImplementationReviewError("Git HEAD не совпадает с reviewed head пакета");
  }
  if (remoteHead !== expectedHead) {
    throw new ImplementationReviewError(
      "Origin корневой ветки не совпадает с reviewed head пакета",
    );
  }
}

async function assertSessionRepositoryState(
  command: BoundedCommandRunner,
  gitRoot: string,
  session: PendingImplementationReviewSession,
  signal?: AbortSignal,
): Promise<void> {
  await assertCleanTaskWorktree(command, gitRoot, signal);
  const [branch, localRoot, remoteRoot, repository] = await Promise.all([
    readCurrentTaskBranch(command, gitRoot, signal),
    readLocalTaskBranchCommit(command, gitRoot, session.changeBranch, signal),
    readRemoteTaskBranchCommit(command, gitRoot, session.changeBranch, signal),
    resolveTaskRepository(command, gitRoot, signal),
  ]);
  if (branch !== session.implementationBranch) {
    throw new ImplementationReviewError(
      `Текущей должна быть корневая ветка «${session.implementationBranch}»`,
    );
  }
  if (localRoot !== await readTaskHeadCommit(command, gitRoot, signal) ||
      (remoteRoot !== session.reviewedHead && remoteRoot !== localRoot)) {
    throw new ImplementationReviewError("Корневая ветка изменилась во время implementation review");
  }
  if (
    repository.host !== session.repository.host ||
    repository.nameWithOwner.toLowerCase() !== session.repository.nameWithOwner.toLowerCase() ||
    repository.url !== session.repository.url
  ) {
    throw new ImplementationReviewError("GitHub repository identity изменилась");
  }
  await assertTaskCommitDescendsFrom(
    command,
    gitRoot,
    session.rootBaselineCommit,
    session.reviewedHead,
    "Reviewed head не продолжает root baseline",
    signal,
  );
}

async function readCommitRange(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  base: string,
  head: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  try {
    const result = await command("git", ["rev-list", "--reverse", `${base}..${head}`], {
      cwd: workspaceDirectory,
      signal,
    });
    return result.stdout.trim().split("\n").filter(Boolean).map((commit) =>
      commitHashSchema.parse(commit)
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ImplementationReviewError("Не удалось прочитать task-коммиты review range");
  }
}

function assertTaskCommitCoverage(
  commits: readonly string[],
  tasks: readonly ImplementationTaskCommit[],
): void {
  let cursor = 0;
  for (const task of tasks) {
    while (cursor < commits.length && commits[cursor] !== task.commit) cursor += 1;
    if (cursor === commits.length) {
      throw new ImplementationReviewError(
        "Завершающие коммиты задач не идут по порядку в Git-диапазоне review",
      );
    }
    cursor += 1;
  }
  if (cursor !== commits.length) {
    throw new ImplementationReviewError(
      "После завершающего коммита последней задачи есть непроверенные коммиты",
    );
  }
}

function assertSessionMatchesRun(
  session: PendingImplementationReviewSession,
  run: ImplementationRun,
): void {
  if (
    run.batch.kind !== "collecting" ||
    session.changeId !== run.changeId ||
    session.implementationBranch !== run.implementationBranch ||
    session.baseCommit !== run.batch.baseCommit ||
    session.reviewedHead !== run.batch.headCommit ||
    !sameStrings(session.tasks.map(({ commit }) => commit), run.batch.tasks.map(({ commit }) => commit))
  ) {
    throw new ImplementationReviewError(
      "Implementation review session не соответствует текущему пакету",
    );
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function completionResult(review: CompletedImplementationReview): {
  readonly text: string;
  readonly data: CompletedImplementationReview;
} {
  return { text: "Implementation review принят и опубликован", data: review };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}
