import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { CompleteRequiredAgentProfile } from "./agent-profiles.ts";
import {
  combineAbortSignals,
  throwIfSignalAborted,
} from "./agent-session-control.ts";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { changeBranchFor } from "./change-branch.ts";
import { isCommitAncestor } from "./git-ancestry.ts";
import { deliverRootCommit } from "./root-branch-delivery.ts";
import {
  assertActiveReviewPullRequest,
  findingCompletionInputSchema,
  inspectReviewFindingPublication,
  parseFindingCompletionInput,
  publishReviewFindingOutcome,
  reviewFindingOutcomeSchema,
  type CompletedFindingPullRequest,
  type ReviewFindingOutcome,
  type ReviewFindingPublicationKind,
} from "./review-finding-publication.ts";
import { ChangeReviewPublicationError } from "./review-publication-model.ts";
import {
  reviewFindingIdSchema,
  type ReviewFindingId,
} from "./change-review-report.ts";
import { createManagedAgentSession } from "./managed-agent-session.ts";
import {
  McpToolError,
  OrchestratorMcpToolHost,
  defineMcpTool,
} from "./orchestrator-mcp-tool-host.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import {
  createTaskScopeCheck,
  type PhaseTaskScope,
  type PhaseWorkService,
  type TaskScopeCheck,
} from "./phase-work.ts";
import {
  updateAgentNotificationLabel,
  type AgentNotificationLabelUpdater,
} from "./paseo-agent-labels.ts";
import {
  createReviewFindingContextReader,
  parseChangeId,
  type ReviewFindingContextReaderOptions,
} from "./review-finding-context.ts";
import {
  RESUMABLE_SESSION,
  staleSession,
  type SessionAssessment,
} from "./session-assessment.ts";
import {
  ReviewFindingResolutionError,
  findingResolutionBranchSchema,
  parseFindingResolutionBranch,
  type ActiveReviewFindingReport,
  type CompletedReviewFindingResolution,
  type ReviewFindingPromptInput,
  type ReviewFindingReportLocation,
  type ReviewFindingResolutionBehavior,
  type ReviewFindingResolutionPlan,
  type ReviewFindingResolutionSession,
  type VerifiedReviewFindingResolution,
} from "./review-finding-resolution-model.ts";
import {
  assertCleanWorktree,
  assertCurrentBranch,
  assertRemoteHead,
  describeFindingRangeViolation,
  assertReviewTracked,
  readHeadCommit,
  readLocalResolutionIfReady,
  verifyCompletedResolution,
} from "./review-finding-verification.ts";

export {
  ReviewFindingResolutionError,
  buildFindingResolutionPrompt,
  findingResolutionBranchSchema,
} from "./review-finding-resolution-model.ts";
export type {
  ActiveReviewFindingReport,
  CompletedReviewFindingResolution,
  ReviewFindingPromptInput,
  ReviewFindingPromptVariant,
  ReviewFindingReportLocation,
  ReviewFindingResolutionBehavior,
  ReviewFindingResolutionPlan,
  ReviewFindingResolutionSession,
} from "./review-finding-resolution-model.ts";

type PaseoApi = PluginHandlerContext["paseo"];
type PaseoWorkspace = ReturnType<PaseoApi["workspaces"]["ref"]>;
type PaseoAgent = Awaited<ReturnType<PaseoWorkspace["agents"]["create"]>>;

export type ReviewFindingResolutionPaseoAgentCreator = (
  options: Parameters<PaseoWorkspace["agents"]["create"]>[0],
) => Promise<PaseoAgent>;

const DEFAULT_AGENT_DRAIN_TIMEOUT_MS = 15_000;

export interface ReviewFindingResolutionRequest<
  Session extends ReviewFindingResolutionSession,
> {
  readonly workspaceDirectory: string;
  readonly changeId: string;
  readonly branch: string;
  readonly profile: CompleteRequiredAgentProfile;
  readonly session: Session;
  /** Фазы, в которые устранение finding может добавлять задачи. */
  readonly taskScope: PhaseTaskScope;
  readonly signal: AbortSignal;
  readonly onAgentCreated: (agentId: string) => void;
  readonly onFindingResolved: (
    resolution: CompletedReviewFindingResolution,
  ) => Promise<void>;
}

export interface ReviewFindingResolutionService<
  Session extends ReviewFindingResolutionSession,
> {
  plan(
    workspaceDirectory: string,
    changeId: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<ReviewFindingResolutionPlan<Session>>;
  /**
   * Оценивает сохранённую finding-сессию, не меняя репозиторий. Сессия
   * продолжается, пока устранение можно завершить и подтвердить ею. Она
   * устарела, когда Git HEAD не продолжает её baseline или после него появились
   * коммиты вне каталога change: их этап принять не может.
   */
  assess(request: {
    readonly workspaceDirectory: string;
    readonly session: Session;
    readonly taskScope: PhaseTaskScope;
    readonly signal: AbortSignal;
  }): Promise<SessionAssessment>;
  run(
    request: ReviewFindingResolutionRequest<Session>,
  ): Promise<CompletedReviewFindingResolution>;
}

/**
 * Состояние сохранённой finding-сессии относительно репозитория: устранение
 * ещё не подтверждено, уже закоммичено и проверено либо сессию нельзя
 * завершить.
 */
type FindingSessionRecovery =
  | { readonly kind: "unresolved" }
  | { readonly kind: "resolved"; readonly resolution: VerifiedReviewFindingResolution }
  | { readonly kind: "stale"; readonly reason: string };

interface McpHostFactory {
  listen(): Promise<OrchestratorMcpToolHost>;
}

export interface ReviewFindingResolutionServiceOptions {
  readonly createAgent: ReviewFindingResolutionPaseoAgentCreator;
  readonly phaseWork: Pick<PhaseWorkService, "inspect">;
  readonly command?: BoundedCommandRunner;
  readonly resolveRealPath?: ReviewFindingContextReaderOptions<ReviewFindingResolutionSession>["resolveRealPath"];
  readonly inspectPath?: ReviewFindingContextReaderOptions<ReviewFindingResolutionSession>["inspectPath"];
  readonly updateNotificationLabel?: AgentNotificationLabelUpdater;
  readonly mcpHost?: McpHostFactory;
  readonly agentDrainTimeoutMs?: number;
  readonly logger?: Pick<Console, "error" | "warn">;
}
export function createReviewFindingResolutionService<
  Session extends ReviewFindingResolutionSession,
>(
  options: ReviewFindingResolutionServiceOptions,
  behavior: ReviewFindingResolutionBehavior<Session>,
): ReviewFindingResolutionService<Session> {
  const command = options.command ?? runBoundedCommand;
  const contextReader = createReviewFindingContextReader({
    command,
    report: behavior.report,
    ...(options.resolveRealPath == null
      ? {}
      : { resolveRealPath: options.resolveRealPath }),
    ...(options.inspectPath == null ? {} : { inspectPath: options.inspectPath }),
  });
  const updateNotificationLabel =
    options.updateNotificationLabel ?? updateAgentNotificationLabel;
  const mcpHost = options.mcpHost ?? OrchestratorMcpToolHost;
  const agentDrainTimeoutMs =
    options.agentDrainTimeoutMs ?? DEFAULT_AGENT_DRAIN_TIMEOUT_MS;
  const logger = options.logger ?? console;

  const inspectSession = async (
    context: Awaited<ReturnType<typeof contextReader.readContext>>,
    session: Session,
    assertTaskScope: TaskScopeCheck,
    signal: AbortSignal,
  ): Promise<FindingSessionRecovery> => {
    await assertCurrentBranch(command, context.gitRoot, session.branch, signal);
    if (!(await isCommitAncestor(
      command, context.gitRoot, session.baselineCommit, "HEAD", signal,
    ))) {
      return {
        kind: "stale",
        reason: "Текущий Git HEAD больше не продолжает baseline finding-сессии",
      };
    }
    const resolution = await readLocalResolutionIfReady(
      command,
      context,
      session,
      behavior,
      contextReader.readReport,
      assertTaskScope,
      signal,
    );
    if (resolution) return { kind: "resolved", resolution };
    // Этап принимает только коммиты внутри каталога change. Если после
    // baseline уже есть иные коммиты, завершить эту сессию нельзя: finding
    // планируется заново от текущего HEAD. Незавершённое устранение
    // продолжает агент той же сессии.
    const violation = await describeFindingRangeViolation(command, context, session, signal);
    return violation === null ? { kind: "unresolved" } : { kind: "stale", reason: violation };
  };
  const scopeCheck = (
    workspaceDirectory: string,
    changeId: string,
    taskScope: PhaseTaskScope,
  ): TaskScopeCheck =>
    createTaskScopeCheck(
      options.phaseWork,
      workspaceDirectory,
      changeId,
      taskScope,
      (message) => new ReviewFindingResolutionError(message),
    );

  return {
    async assess(request) {
      const session = behavior.sessionSchema.parse(request.session);
      const context = await contextReader.readContext(
        request.workspaceDirectory,
        session.changeId,
        request.signal,
      );
      const recovery = await inspectSession(
        context,
        session,
        scopeCheck(request.workspaceDirectory, session.changeId, request.taskScope),
        request.signal,
      );
      return recovery.kind === "stale" ? staleSession(recovery.reason) : RESUMABLE_SESSION;
    },

    async plan(workspaceDirectory, changeId, branch, signal) {
      const parsedBranch = parseFindingResolutionBranch(branch);
      if (parsedBranch !== changeBranchFor(changeId)) {
        throw new ReviewFindingResolutionError("Finding должен устраняться в корневой ветке change");
      }
      const context = await contextReader.readContext(
        workspaceDirectory,
        changeId,
        signal,
      );
      await assertCurrentBranch(command, context.gitRoot, parsedBranch, signal);
      await assertCleanWorktree(command, context.gitRoot, signal);
      const head = await readHeadCommit(command, context.gitRoot, signal);
      await assertRemoteHead(command, context.gitRoot, parsedBranch, head, signal);
      try {
        await assertActiveReviewPullRequest(
          context.gitRoot,
          context.changeId,
          parsedBranch,
          signal,
          command,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof ChangeReviewPublicationError) {
          throw new ReviewFindingResolutionError(error.message);
        }
        throw new ReviewFindingResolutionError(
          "Не удалось проверить корневой PR текущей ветки",
        );
      }

      if (
        behavior.report.missingMeansNoFindings &&
        !(await contextReader.reportExists(context, signal))
      ) {
        return {
          kind: "no-findings",
          reviewPath: context.reviewRepositoryPath,
          headCommit: head,
        };
      }

      await assertReviewTracked(command, context, behavior.report.fileName, signal);
      const report = await contextReader.readReport(context, signal);
      const firstFinding = report.findings[0];
      if (!firstFinding) {
        return {
          kind: "no-findings",
          reviewPath: context.reviewRepositoryPath,
          headCommit: head,
        };
      }
      return {
        kind: "finding-required",
        findingId: firstFinding.id,
        session: behavior.sessionSchema.parse({
          changeId: context.changeId,
          branch: parsedBranch,
          findingId: firstFinding.id,
          baselineCommit: head,
        }),
      };
    },

    async run(request) {
      throwIfSignalAborted(request.signal);
      const session = behavior.sessionSchema.parse(request.session);
      const changeId = parseChangeId(request.changeId);
      const branch = parseFindingResolutionBranch(request.branch);
      if (session.changeId !== changeId || session.branch !== branch || branch !== changeBranchFor(changeId)) {
        throw new ReviewFindingResolutionError(
          "Сохранённая finding-сессия относится к другому change или Git-ветке",
        );
      }

      const context = await contextReader.readContext(
        request.workspaceDirectory,
        changeId,
        request.signal,
      );
      const assertTaskScope = scopeCheck(request.workspaceDirectory, changeId, request.taskScope);
      const recovery = await inspectSession(context, session, assertTaskScope, request.signal);
      // Устаревшую сессию сбрасывает согласование перед шагом; здесь она
      // возможна только при изменении репозитория после него.
      if (recovery.kind === "stale") throw new ReviewFindingResolutionError(recovery.reason);
      const existingLocalResolution = recovery.kind === "resolved" ? recovery.resolution : null;
      if (existingLocalResolution) {
        await deliverRootCommit(
          context.gitRoot,
          changeId,
          session.baselineCommit,
          existingLocalResolution.commit,
          request.signal,
          command,
        );
      }
      let publicationAlreadyCompleted: boolean;
      try {
        publicationAlreadyCompleted = (
          await inspectReviewFindingPublication(
            {
              workspaceDirectory: context.gitRoot,
              changeId,
              branch,
              findingId: session.findingId,
              baselineCommit: session.baselineCommit,
              kind: behavior.publication.kind,
              expectedHead: existingLocalResolution?.commit,
              expectedOutcome: existingLocalResolution?.outcome,
              signal: request.signal,
            },
            command,
          )
        ).entryExists;
      } catch (error) {
        if (request.signal.aborted) throw error;
        if (error instanceof ChangeReviewPublicationError) {
          throw new ReviewFindingResolutionError(error.message);
        }
        throw new ReviewFindingResolutionError(
          "Не удалось проверить публикацию finding в корневом PR",
        );
      }
      if (publicationAlreadyCompleted && !existingLocalResolution) {
        throw new ReviewFindingResolutionError(
          "Review pull request содержит результат finding без корректного локального коммита",
        );
      }
      const host = await mcpHost.listen();
      let completedResolution: CompletedReviewFindingResolution | null = null;
      const agentSession =
        createManagedAgentSession<CompletedReviewFindingResolution>({
          signal: request.signal,
          host,
          updateNotificationLabel,
          agentDrainTimeoutMs,
          logContext: behavior.agent.logLabel,
          logger,
        });

      const completedResolutionSchema = z
        .object({
          changeId: openSpecChangeIdSchema,
          findingId: reviewFindingIdSchema,
          remainingFindingIds: z.array(reviewFindingIdSchema).max(256),
          commit: commitHashSchema,
          outcome: reviewFindingOutcomeSchema,
          pullRequest: z
            .object({
              number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
              url: z.string().url().max(2_048),
            })
            .strict(),
        })
        .strict();
      const tool = defineMcpTool({
        description: behavior.agent.toolDescription,
        inputSchema: findingCompletionInputSchema,
        outputSchema: completedResolutionSchema,
        execute: (input, toolContext) =>
          agentSession.runExclusive(async () => {
            if (completedResolution) {
              return completionToolResult(
                completedResolution,
                behavior.agent.completionLabel,
              );
            }
            const combined = combineAbortSignals(request.signal, toolContext.signal);
            const { signal } = combined;
            try {
              const activeAgent = await agentSession.waitForAgent(signal);
              let localResolution: VerifiedReviewFindingResolution;
              try {
                localResolution = await verifyCompletedResolution(
                  command,
                  context,
                  session,
                  behavior,
                  contextReader.readReport,
                  assertTaskScope,
                  signal,
                );
              } catch (error) {
                if (error instanceof ReviewFindingResolutionError) {
                  throw new McpToolError(error.message);
                }
                if (signal.aborted) throw error;
                logger.error(`[OpenSpec] Не удалось проверить ${behavior.agent.logLabel}`, {
                  changeId,
                  findingId: session.findingId,
                  code: errorCode(error),
                });
                throw new McpToolError(
                  `Не удалось проверить ${behavior.agent.logLabel}`,
                );
              }

              let verified: CompletedReviewFindingResolution;
              try {
                const pullRequest = await publishReviewFindingOutcome(
                  {
                    workspaceDirectory: context.gitRoot,
                    changeId,
                    branch,
                    findingId: session.findingId,
                    baselineCommit: session.baselineCommit,
                    expectedHead: localResolution.commit,
                    kind: behavior.publication.kind,
                    outcome: localResolution.outcome,
                    input: parseFindingCompletionInput(input),
                    signal,
                  },
                  command,
                );
                verified = { ...localResolution, pullRequest };
              } catch (error) {
                if (error instanceof ChangeReviewPublicationError) {
                  throw new McpToolError(error.message);
                }
                if (signal.aborted) throw error;
                logger.error(`[OpenSpec] Не удалось опубликовать ${behavior.agent.logLabel}`, {
                  changeId,
                  findingId: session.findingId,
                  code: errorCode(error),
                });
                throw new McpToolError(
                  "Не удалось обновить корневой PR результатом finding",
                );
              }

              try {
                await agentSession.disableNotifications(signal);
              } catch (error) {
                if (signal.aborted) throw error;
                logger.error(`[OpenSpec] Не удалось отключить ntfy ${behavior.agent.logLabel}`, {
                  agentId: activeAgent.id,
                  code: errorCode(error),
                });
                throw new McpToolError(
                  "Не удалось отключить финальное уведомление агента; повторите вызов",
                );
              }

              try {
                await request.onFindingResolved(verified);
              } catch (error) {
                logger.error(`[OpenSpec] Не удалось сохранить ${behavior.agent.logLabel}`, {
                  changeId,
                  findingId: session.findingId,
                  code: errorCode(error),
                });
                try {
                  await agentSession.restoreNotifications(request.signal);
                } catch (restoreError) {
                  logger.warn(`[OpenSpec] Не удалось восстановить ntfy ${behavior.agent.logLabel}`, {
                    agentId: activeAgent.id,
                    code: errorCode(restoreError),
                  });
                }
                throw new McpToolError(
                  "Не удалось надёжно сохранить устранение finding; повторите вызов",
                );
              }

              completedResolution = verified;
              agentSession.complete(verified);
              return completionToolResult(verified, behavior.agent.completionLabel);
            } finally {
              combined.dispose();
            }
          }),
      });
      const scope = await agentSession.openScope(() =>
        host.expose({ [behavior.agent.toolName]: tool }),
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
        await agentSession.launchAgent(
          () =>
            options.createAgent({
              config,
              title: behavior.agent.title(session.findingId),
              prompt: behavior.agent.prompt({
                changeId,
                findingId: session.findingId,
                branch,
                reviewRepositoryPath: context.reviewRepositoryPath,
                alreadyCommitted: existingLocalResolution !== null,
                publicationAlreadyCompleted,
                taskScope: request.taskScope,
              }),
              labels: { ntfy: "true" },
            }),
          request.onAgentCreated,
        );

        const resolution = await agentSession.waitForCompletion();
        await new Promise<void>((resolveDrain) => setImmediate(resolveDrain));
        await agentSession.drainAgent();
        return resolution;
      } finally {
        await agentSession.close();
      }
    },
  };
}

function completionToolResult(
  resolution: CompletedReviewFindingResolution,
  completionLabel: string,
): {
  readonly text: string;
  readonly data: {
    readonly changeId: string;
    readonly findingId: ReviewFindingId;
    readonly remainingFindingIds: ReviewFindingId[];
    readonly commit: string;
    readonly outcome: ReviewFindingOutcome;
    readonly pullRequest: CompletedFindingPullRequest;
  };
} {
  return {
    text: `${completionLabel} «${resolution.findingId}» обработана и опубликована в PR #${resolution.pullRequest.number}`,
    data: {
      ...resolution,
      remainingFindingIds: [...resolution.remainingFindingIds],
    },
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}
