import type { lstat } from "node:fs/promises";
import { z } from "zod";
import type { CompleteRequiredAgentProfile } from "./agent-profiles.ts";
import {
  combineAbortSignals,
  throwIfSignalAborted,
} from "./agent-session-control.ts";
import type { BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import { changeBranchFor } from "./change-branch.ts";
import { reviewFindingIdSchema } from "./change-review-report.ts";
import { isCommitAncestor } from "./git-ancestry.ts";
import { createManagedAgentSession } from "./managed-agent-session.ts";
import {
  McpToolError,
  defineMcpTool,
} from "./orchestrator-mcp-tool-host.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import type { PhaseTaskScope } from "./phase-work.ts";
import {
  commitFindingDecisions,
  findingDecisionsRepositoryPath,
} from "./review-finding-decision-git.ts";
import {
  FindingDecisionsError,
  bindFindingDecisions,
  decisionFor,
  executableDecisionFor,
  findingDecisionsInputSchema,
  sameFindingDecisions,
  type ActiveFinding,
  type ExecutableFindingDecisionRecord,
} from "./review-finding-decision-model.ts";
import {
  parseChangeId,
  type ReviewFindingContextReader,
} from "./review-finding-context.ts";
import {
  ReviewFindingResolutionError,
  parseFindingResolutionBranch,
  pendingFindingDecisionSessionSchema,
  type FindingResolutionContext,
  type PendingFindingDecisionSession,
  type RecordedFindingDecisions,
  type ReviewFindingResolutionBehavior,
  type ReviewFindingResolutionSession,
} from "./review-finding-resolution-model.ts";
import type { ReviewFindingResolutionServiceOptions } from "./review-finding-resolution.ts";
import {
  assertCleanWorktree,
  assertCurrentBranch,
  readDecisions,
  readHeadCommit,
} from "./review-finding-verification.ts";
import { deliverRootCommit, RootBranchDeliveryError } from "./root-branch-delivery.ts";
import {
  RESUMABLE_SESSION,
  staleSession,
  type SessionAssessment,
} from "./session-assessment.ts";

export interface FindingDecisionRequest {
  readonly workspaceDirectory: string;
  readonly changeId: string;
  readonly branch: string;
  readonly profile: CompleteRequiredAgentProfile;
  readonly session: PendingFindingDecisionSession;
  /** Фазы, в которые исполнение решений сможет добавлять задачи. */
  readonly taskScope: PhaseTaskScope;
  readonly signal: AbortSignal;
  readonly onAgentCreated: (agentId: string) => void;
  readonly onDecisionsRecorded: (recorded: RecordedFindingDecisions) => Promise<void>;
}

export interface FindingDecisionAssessmentRequest {
  readonly workspaceDirectory: string;
  readonly session: PendingFindingDecisionSession;
  readonly signal: AbortSignal;
}

export interface FindingDecisionSessions {
  /**
   * Собирает решения пользователя по всем findings сессии, записывает их в
   * файл решений одним коммитом оркестратора и публикует этот коммит.
   */
  decide(request: FindingDecisionRequest): Promise<RecordedFindingDecisions>;
  /**
   * Сессия продолжается, пока решения ещё не записаны либо уже записаны
   * проверяемым коммитом. Она устарела, когда HEAD не продолжает baseline
   * или после него появились другие изменения.
   */
  assess(request: FindingDecisionAssessmentRequest): Promise<SessionAssessment>;
}

type DecisionSessionState =
  | { readonly kind: "pending" }
  | { readonly kind: "recorded"; readonly recorded: RecordedFindingDecisions }
  | { readonly kind: "stale"; readonly reason: string };

interface FindingDecisionSessionDependencies<
  Session extends ReviewFindingResolutionSession,
> {
  readonly command: BoundedCommandRunner;
  readonly contextReader: ReviewFindingContextReader;
  readonly behavior: ReviewFindingResolutionBehavior<Session>;
  readonly options: ReviewFindingResolutionServiceOptions;
  readonly updateNotificationLabel: NonNullable<
    ReviewFindingResolutionServiceOptions["updateNotificationLabel"]
  >;
  readonly mcpHost: NonNullable<ReviewFindingResolutionServiceOptions["mcpHost"]>;
  readonly agentDrainTimeoutMs: number;
  readonly logger: Pick<Console, "error" | "warn">;
  readonly inspectPath?: typeof lstat;
}

const recordedDecisionsOutputSchema = z
  .object({
    changeId: openSpecChangeIdSchema,
    commit: commitHashSchema,
    findingIds: z.array(reviewFindingIdSchema).max(256),
  })
  .strict();

export function createFindingDecisionSessions<
  Session extends ReviewFindingResolutionSession,
>(
  dependencies: FindingDecisionSessionDependencies<Session>,
): FindingDecisionSessions {
  const { command, contextReader, behavior, logger } = dependencies;
  const kind = behavior.publication.kind;

  /** Открытые findings отчёта в порядке сессии; другой набор — ошибка. */
  const readSessionFindings = async (
    context: FindingResolutionContext,
    session: PendingFindingDecisionSession,
    signal?: AbortSignal,
  ): Promise<readonly ActiveFinding[]> => {
    const report = await contextReader.readReport(context, signal);
    const ids = report.findings.map(({ id }) => id);
    if (
      ids.length !== session.findingIds.length ||
      ids.some((id, index) => id !== session.findingIds[index])
    ) {
      throw new ReviewFindingResolutionError(
        `${behavior.report.fileName} изменился после начала сессии решений`,
      );
    }
    return report.findings;
  };

  /**
   * Диапазон после baseline подтверждает сессию, только когда он меняет один
   * файл решений и тот содержит решение по каждой finding сессии.
   */
  const verifyRecorded = async (
    context: FindingResolutionContext,
    session: PendingFindingDecisionSession,
    head: string,
    signal?: AbortSignal,
  ): Promise<RecordedFindingDecisions> => {
    const decisionsPath = findingDecisionsRepositoryPath(context.changeRepositoryPath, kind);
    let changedPaths: string[];
    try {
      const { stdout } = await command(
        "git",
        ["diff", "--name-only", "--no-renames", "-z", `${session.baselineCommit}..${head}`],
        { cwd: context.gitRoot, signal },
      );
      changedPaths = stdout.split("\0").filter(Boolean);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ReviewFindingResolutionError("Не удалось проверить состав коммитов решений");
    }
    if (changedPaths.length !== 1 || changedPaths[0] !== decisionsPath) {
      throw new ReviewFindingResolutionError(
        `После начала сессии решений изменены файлы, кроме ${decisionsPath}`,
      );
    }
    const findings = await readSessionFindings(context, session, signal);
    const records = await readDecisions(command, context, behavior, head, signal);
    const decisions: ExecutableFindingDecisionRecord[] = [];
    for (const finding of findings) {
      const record = executableDecisionFor(records, finding);
      if (!record) {
        throw new ReviewFindingResolutionError(
          `${decisionsPath} не содержит решения по finding «${finding.id}»`,
        );
      }
      decisions.push(record);
    }
    return {
      changeId: context.changeId,
      commit: head,
      decisions: Object.freeze(decisions),
    };
  };

  const inspect = async (
    context: FindingResolutionContext,
    session: PendingFindingDecisionSession,
    signal: AbortSignal,
  ): Promise<DecisionSessionState> => {
    await assertCurrentBranch(command, context.gitRoot, session.branch, signal);
    if (!(await isCommitAncestor(
      command, context.gitRoot, session.baselineCommit, "HEAD", signal,
    ))) {
      return {
        kind: "stale",
        reason: "Текущий Git HEAD больше не продолжает baseline сессии решений",
      };
    }
    const head = await readHeadCommit(command, context.gitRoot, signal);
    if (head === session.baselineCommit) return { kind: "pending" };
    // Незакоммиченные правки не делают сессию устаревшей: о них сообщает шаг.
    await assertCleanWorktree(command, context.gitRoot, signal);
    try {
      return { kind: "recorded", recorded: await verifyRecorded(context, session, head, signal) };
    } catch (error) {
      if (error instanceof ReviewFindingResolutionError) {
        return { kind: "stale", reason: error.message };
      }
      throw error;
    }
  };

  const deliver = (
    context: FindingResolutionContext,
    session: PendingFindingDecisionSession,
    recorded: RecordedFindingDecisions,
    signal: AbortSignal,
  ): Promise<void> =>
    deliverRootCommit(
      context.gitRoot,
      context.changeId,
      session.baselineCommit,
      recorded.commit,
      signal,
      command,
    );

  return {
    async assess(request) {
      const session = pendingFindingDecisionSessionSchema.parse(request.session);
      const context = await contextReader.readContext(
        request.workspaceDirectory,
        session.changeId,
        request.signal,
      );
      const state = await inspect(context, session, request.signal);
      return state.kind === "stale" ? staleSession(state.reason) : RESUMABLE_SESSION;
    },

    async decide(request) {
      throwIfSignalAborted(request.signal);
      const session = pendingFindingDecisionSessionSchema.parse(request.session);
      const changeId = parseChangeId(request.changeId);
      const branch = parseFindingResolutionBranch(request.branch);
      if (
        session.changeId !== changeId ||
        session.branch !== branch ||
        branch !== changeBranchFor(changeId)
      ) {
        throw new ReviewFindingResolutionError(
          "Сохранённая сессия решений относится к другому change или Git-ветке",
        );
      }
      const context = await contextReader.readContext(
        request.workspaceDirectory,
        changeId,
        request.signal,
      );
      const initial = await inspect(context, session, request.signal);
      if (initial.kind === "stale") throw new ReviewFindingResolutionError(initial.reason);
      if (initial.kind === "recorded") {
        // Решения уже закоммичены: агент не нужен, остаётся публикация.
        await deliver(context, session, initial.recorded, request.signal);
        await request.onDecisionsRecorded(initial.recorded);
        return initial.recorded;
      }

      await assertCleanWorktree(command, context.gitRoot, request.signal);
      const findings = await readSessionFindings(context, session, request.signal);
      const baselineRecords = await readDecisions(
        command, context, behavior, session.baselineCommit, request.signal,
      );
      const blockers = Object.fromEntries(
        findings.flatMap((finding) => {
          const decision = decisionFor(baselineRecords, finding)?.decision;
          return decision?.kind === "blocked" ? [[finding.id, decision.reason]] : [];
        }),
      );

      const host = await dependencies.mcpHost.listen();
      let completed: RecordedFindingDecisions | null = null;
      const agentSession = createManagedAgentSession<RecordedFindingDecisions>({
        signal: request.signal,
        releaseAgent: dependencies.options.releaseAgent,
        host,
        updateNotificationLabel: dependencies.updateNotificationLabel,
        agentDrainTimeoutMs: dependencies.agentDrainTimeoutMs,
        logContext: behavior.decisions.logLabel,
        logger,
      });

      const tool = defineMcpTool({
        description: behavior.decisions.toolDescription,
        inputSchema: findingDecisionsInputSchema,
        outputSchema: recordedDecisionsOutputSchema,
        execute: (input, toolContext) =>
          agentSession.runExclusive(async () => {
            if (completed) return decisionsToolResult(completed);
            const combined = combineAbortSignals(request.signal, toolContext.signal);
            const { signal } = combined;
            try {
              const activeAgent = await agentSession.waitForAgent(signal);
              let recorded: RecordedFindingDecisions;
              try {
                const decisions = bindFindingDecisions(findings, input);
                const state = await inspect(context, session, signal);
                if (state.kind === "stale") throw new ReviewFindingResolutionError(state.reason);
                if (state.kind === "recorded") {
                  // Повторный вызов после сбоя публикации: коммит уже есть.
                  if (!sameFindingDecisions(state.recorded.decisions, decisions)) {
                    throw new ReviewFindingResolutionError(
                      `Решения уже записаны коммитом ${state.recorded.commit} и отличаются от переданных`,
                    );
                  }
                  recorded = state.recorded;
                } else {
                  try {
                    await assertCleanWorktree(command, context.gitRoot, signal);
                  } catch (error) {
                    if (error instanceof ReviewFindingResolutionError) {
                      throw new ReviewFindingResolutionError(
                        "Сессия решений не должна менять файлы: верните рабочее дерево в исходное состояние",
                      );
                    }
                    throw error;
                  }
                  await commitFindingDecisions({
                    command,
                    paths: context,
                    kind,
                    records: decisions,
                    subject: behavior.decisions.commitSubject,
                    signal,
                    ...(dependencies.inspectPath === undefined
                      ? {}
                      : { inspectPath: dependencies.inspectPath }),
                  });
                  const written = await inspect(context, session, signal);
                  if (written.kind !== "recorded") {
                    throw new ReviewFindingResolutionError(
                      written.kind === "stale"
                        ? written.reason
                        : "Коммит решений не появился в Git HEAD",
                    );
                  }
                  recorded = written.recorded;
                }
                await deliver(context, session, recorded, signal);
              } catch (error) {
                if (
                  error instanceof ReviewFindingResolutionError ||
                  error instanceof FindingDecisionsError ||
                  error instanceof RootBranchDeliveryError
                ) {
                  logger.warn(`[OpenSpec] Отклонены ${behavior.decisions.logLabel}`, {
                    changeId,
                    reason: error.message,
                  });
                  throw new McpToolError(error.message);
                }
                if (signal.aborted) throw error;
                logger.error(`[OpenSpec] Не удалось записать ${behavior.decisions.logLabel}`, {
                  changeId,
                  code: errorCode(error),
                });
                throw new McpToolError("Не удалось записать решения по findings");
              }

              try {
                await agentSession.disableNotifications(signal);
              } catch (error) {
                if (signal.aborted) throw error;
                logger.error(`[OpenSpec] Не удалось отключить ntfy ${behavior.decisions.logLabel}`, {
                  agentId: activeAgent.id,
                  code: errorCode(error),
                });
                throw new McpToolError(
                  "Не удалось отключить финальное уведомление агента; повторите вызов",
                );
              }

              try {
                await request.onDecisionsRecorded(recorded);
              } catch (error) {
                logger.error(`[OpenSpec] Не удалось сохранить ${behavior.decisions.logLabel}`, {
                  changeId,
                  code: errorCode(error),
                });
                try {
                  await agentSession.restoreNotifications(request.signal);
                } catch (restoreError) {
                  logger.warn(`[OpenSpec] Не удалось восстановить ntfy ${behavior.decisions.logLabel}`, {
                    agentId: activeAgent.id,
                    code: errorCode(restoreError),
                  });
                }
                throw new McpToolError(
                  "Не удалось надёжно сохранить решения по findings; повторите вызов",
                );
              }

              completed = recorded;
              agentSession.complete(recorded);
              return decisionsToolResult(recorded);
            } finally {
              combined.dispose();
            }
          }),
      });
      const scope = await agentSession.openScope(() =>
        host.expose({ [behavior.decisions.toolName]: tool }),
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
            dependencies.options.createAgent({
              config,
              title: behavior.decisions.title,
              prompt: behavior.decisions.prompt({
                changeId,
                branch,
                findingIds: session.findingIds,
                blockers,
                reviewRepositoryPath: context.reviewRepositoryPath,
                decisionsRepositoryPath: findingDecisionsRepositoryPath(
                  context.changeRepositoryPath,
                  kind,
                ),
                taskScope: request.taskScope,
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
  };
}

function decisionsToolResult(recorded: RecordedFindingDecisions): {
  readonly text: string;
  readonly data: z.input<typeof recordedDecisionsOutputSchema>;
} {
  const findingIds = recorded.decisions.map(({ findingId }) => findingId);
  return {
    text: `Решения по findings ${findingIds.join(", ")} записаны и опубликованы коммитом ${recorded.commit}`,
    data: { changeId: recorded.changeId, commit: recorded.commit, findingIds },
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}
