import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { CompleteRequiredAgentProfile } from "./agent-profiles.ts";
import {
  abortError,
  combineAbortSignals,
  createDeferred,
  createSerializedExecutor,
  throwIfSignalAborted,
  waitForPromise,
} from "./agent-session-control.ts";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
import {
  reviewFindingIdSchema,
  type ReviewFindingId,
} from "./change-review-report.ts";
import { runWorkspaceMiseCommand } from "./mise-toolchain.ts";
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
import {
  resolveRepoLocalChangePaths,
  type RepoLocalChangePaths,
} from "./repo-local-change.ts";

type PaseoApi = PluginHandlerContext["paseo"];
type PaseoWorkspace = ReturnType<PaseoApi["workspaces"]["ref"]>;
type PaseoAgent = Awaited<ReturnType<PaseoWorkspace["agents"]["create"]>>;

export type ReviewFindingResolutionPaseoAgentCreator = (
  options: Parameters<PaseoWorkspace["agents"]["create"]>[0],
) => Promise<PaseoAgent>;

const REVIEW_REMOTE = "origin";
const DEFAULT_AGENT_DRAIN_TIMEOUT_MS = 15_000;
const MAX_PATH_LENGTH = 8_192;

export const findingResolutionBranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u, "Имя Git-ветки содержит небезопасные символы")
  .refine(
    (value) =>
      value !== "@" &&
      value !== "main" &&
      !value.includes("..") &&
      !value.includes("//") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")),
    "Для устранения finding требуется безопасное имя non-main Git-ветки",
  );

const resolutionStatusSchema = z
  .object({
    changeName: openSpecChangeIdSchema,
    changeRoot: z.string().trim().min(1).max(MAX_PATH_LENGTH),
    actionContext: z
      .object({
        mode: z.literal("repo-local"),
        sourceOfTruth: z.literal("repo"),
      })
      .loose(),
  })
  .loose();

export interface ReviewFindingResolutionSession {
  readonly changeId: string;
  readonly branch: string;
  readonly findingId: ReviewFindingId;
  readonly baselineCommit: string;
}

export type ReviewFindingResolutionPlan<Session extends ReviewFindingResolutionSession> =
  | {
      readonly kind: "no-findings";
      readonly reviewPath: string;
    }
  | {
      readonly kind: "finding-required";
      readonly findingId: ReviewFindingId;
      readonly session: Session;
    };

export interface CompletedReviewFindingResolution {
  readonly changeId: string;
  readonly findingId: ReviewFindingId;
  readonly remainingFindingIds: readonly ReviewFindingId[];
  readonly commit: string;
}

export interface ReviewFindingResolutionRequest<
  Session extends ReviewFindingResolutionSession,
> {
  readonly workspaceDirectory: string;
  readonly changeId: string;
  readonly branch: string;
  readonly profile: CompleteRequiredAgentProfile;
  readonly session: Session;
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
  run(
    request: ReviewFindingResolutionRequest<Session>,
  ): Promise<CompletedReviewFindingResolution>;
}

interface McpHostFactory {
  listen(): Promise<OrchestratorMcpToolHost>;
}

export interface ReviewFindingResolutionServiceOptions {
  readonly createAgent: ReviewFindingResolutionPaseoAgentCreator;
  readonly command?: BoundedCommandRunner;
  readonly resolveRealPath?: typeof realpath;
  readonly inspectPath?: typeof lstat;
  readonly updateNotificationLabel?: AgentNotificationLabelUpdater;
  readonly mcpHost?: McpHostFactory;
  readonly agentDrainTimeoutMs?: number;
  readonly logger?: Pick<Console, "error" | "warn">;
}

interface FindingResolutionContext extends RepoLocalChangePaths {
  readonly changeId: string;
  readonly reviewPath: string;
  readonly reviewRepositoryPath: string;
}

export interface ReviewFindingReportLocation {
  readonly reviewPath: string;
  readonly changeRoot: string;
  readonly expectedChangeId: string;
  readonly inspectPath: typeof lstat;
  readonly resolveRealPath: typeof realpath;
}

export interface ActiveReviewFindingReport {
  readonly findings: readonly { readonly id: ReviewFindingId }[];
}

export interface ReviewFindingPromptInput {
  readonly changeId: string;
  readonly findingId: ReviewFindingId;
  readonly branch: string;
  readonly reviewRepositoryPath: string;
  readonly alreadyCommitted: boolean;
}

export interface ReviewFindingResolutionBehavior<
  Session extends ReviewFindingResolutionSession,
> {
  readonly reportFileName: string;
  readonly missingReportMeansNoFindings: boolean;
  readonly toolName: string;
  readonly toolDescription: string;
  readonly agentTitle: (findingId: ReviewFindingId) => string;
  readonly logLabel: string;
  readonly completionLabel: string;
  readonly sessionSchema: z.ZodType<Session>;
  readonly readReport: (
    location: ReviewFindingReportLocation,
    signal?: AbortSignal,
  ) => Promise<ActiveReviewFindingReport>;
  readonly commitSubject: (findingId: ReviewFindingId) => string;
  readonly prompt: (input: ReviewFindingPromptInput) => string;
}

export class ReviewFindingResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewFindingResolutionError";
  }
}

export function createReviewFindingResolutionService<
  Session extends ReviewFindingResolutionSession,
>(
  options: ReviewFindingResolutionServiceOptions,
  behavior: ReviewFindingResolutionBehavior<Session>,
): ReviewFindingResolutionService<Session> {
  const command = options.command ?? runBoundedCommand;
  const resolveRealPath = options.resolveRealPath ?? realpath;
  const inspectPath = options.inspectPath ?? lstat;
  const updateNotificationLabel =
    options.updateNotificationLabel ?? updateAgentNotificationLabel;
  const mcpHost = options.mcpHost ?? OrchestratorMcpToolHost;
  const agentDrainTimeoutMs =
    options.agentDrainTimeoutMs ?? DEFAULT_AGENT_DRAIN_TIMEOUT_MS;
  const logger = options.logger ?? console;

  const readContext = async (
    workspaceDirectory: string,
    changeId: string,
    signal?: AbortSignal,
  ): Promise<FindingResolutionContext> => {
    const parsedChangeId = parseChangeId(changeId);
    let stdout: string;
    try {
      ({ stdout } = await runWorkspaceMiseCommand(
        command,
        workspaceDirectory,
        "openspec",
        ["status", "--change", parsedChangeId, "--json"],
        signal,
      ));
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ReviewFindingResolutionError(
        `Не удалось прочитать OpenSpec change «${parsedChangeId}» перед устранением findings`,
      );
    }

    let status: z.output<typeof resolutionStatusSchema>;
    try {
      status = resolutionStatusSchema.parse(JSON.parse(stdout) as unknown);
    } catch {
      throw new ReviewFindingResolutionError(
        `OpenSpec вернул некорректное состояние change «${parsedChangeId}»`,
      );
    }
    if (status.changeName !== parsedChangeId) {
      throw new ReviewFindingResolutionError(
        `OpenSpec вернул другой change вместо «${parsedChangeId}»`,
      );
    }

    let paths: RepoLocalChangePaths;
    try {
      paths = await resolveRepoLocalChangePaths({
        command,
        workspaceDirectory,
        reportedChangeRoot: status.changeRoot,
        signal,
        resolveRealPath,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ReviewFindingResolutionError(
        `Не удалось безопасно определить каталог change «${parsedChangeId}»`,
      );
    }

    return {
      ...paths,
      changeId: parsedChangeId,
      reviewPath: resolve(paths.changeRoot, behavior.reportFileName),
      reviewRepositoryPath: `${paths.changeRepositoryPath}/${behavior.reportFileName}`,
    };
  };

  const readReport = async (
    context: FindingResolutionContext,
    signal?: AbortSignal,
  ): Promise<ActiveReviewFindingReport> => {
    throwIfOptionalSignalAborted(signal);
    const report = await behavior.readReport(
      {
        reviewPath: context.reviewPath,
        changeRoot: context.changeRoot,
        expectedChangeId: context.changeId,
        inspectPath,
        resolveRealPath,
      },
      signal,
    );
    throwIfOptionalSignalAborted(signal);
    return report;
  };

  return {
    async plan(workspaceDirectory, changeId, branch, signal) {
      const parsedBranch = parseBranch(branch);
      const context = await readContext(workspaceDirectory, changeId, signal);
      await assertCurrentBranch(command, context.gitRoot, parsedBranch, signal);
      await assertCleanWorktree(command, context.gitRoot, signal);
      const head = await readHeadCommit(command, context.gitRoot, signal);
      await assertRemoteHead(command, context.gitRoot, parsedBranch, head, signal);

      if (
        behavior.missingReportMeansNoFindings &&
        !(await pathExists(
          inspectPath,
          context.reviewPath,
          behavior.reportFileName,
          signal,
        ))
      ) {
        return {
          kind: "no-findings",
          reviewPath: context.reviewRepositoryPath,
        };
      }

      await assertReviewTracked(command, context, behavior.reportFileName, signal);
      const report = await readReport(context, signal);
      const firstFinding = report.findings[0];
      if (!firstFinding) {
        return {
          kind: "no-findings",
          reviewPath: context.reviewRepositoryPath,
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
      const branch = parseBranch(request.branch);
      if (session.changeId !== changeId || session.branch !== branch) {
        throw new ReviewFindingResolutionError(
          "Сохранённая finding-сессия относится к другому change или Git-ветке",
        );
      }

      const context = await readContext(request.workspaceDirectory, changeId, request.signal);
      await assertCurrentBranch(command, context.gitRoot, branch, request.signal);
      await assertDescendsFromBaseline(
        command,
        context.gitRoot,
        session.baselineCommit,
        request.signal,
      );

      const resolutionAlreadyCommitted = await isLocalResolutionReady(
        command,
        context,
        session,
        behavior,
        readReport,
        request.signal,
      );
      const host = await mcpHost.listen();
      let agent: PaseoAgent | null = null;
      let notificationsDisabled = false;
      let completedResolution: CompletedReviewFindingResolution | null = null;
      const agentReady = createDeferred<PaseoAgent>();
      const completion = createDeferred<CompletedReviewFindingResolution>();
      void completion.promise.catch(() => undefined);
      const abortCompletion = () => completion.reject(abortError());
      request.signal.addEventListener("abort", abortCompletion, { once: true });
      const serialize = createSerializedExecutor();

      const completedResolutionSchema = z
        .object({
          changeId: openSpecChangeIdSchema,
          findingId: reviewFindingIdSchema,
          remainingFindingIds: z.array(reviewFindingIdSchema).max(256),
          commit: commitHashSchema,
        })
        .strict();
      const tool = defineMcpTool({
        description: behavior.toolDescription,
        inputSchema: z.object({}).strict(),
        outputSchema: completedResolutionSchema,
        execute: (_input, toolContext) =>
          serialize(async () => {
            if (completedResolution) {
              return completionToolResult(completedResolution, behavior.completionLabel);
            }
            const combined = combineAbortSignals(request.signal, toolContext.signal);
            const { signal } = combined;
            try {
              const activeAgent = await waitForPromise(agentReady.promise, signal);
              let verified: CompletedReviewFindingResolution;
              try {
                verified = await verifyCompletedResolution(
                  command,
                  context,
                  session,
                  behavior,
                  readReport,
                  signal,
                );
              } catch (error) {
                if (error instanceof ReviewFindingResolutionError) {
                  throw new McpToolError(error.message);
                }
                if (signal.aborted) throw error;
                logger.error(`[OpenSpec] Не удалось проверить ${behavior.logLabel}`, {
                  changeId,
                  findingId: session.findingId,
                  code: errorCode(error),
                });
                throw new McpToolError(`Не удалось проверить ${behavior.logLabel}`);
              }

              try {
                await updateNotificationLabel(activeAgent.id, false, signal);
                notificationsDisabled = true;
              } catch (error) {
                if (signal.aborted) throw error;
                logger.error(`[OpenSpec] Не удалось отключить ntfy ${behavior.logLabel}`, {
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
                logger.error(`[OpenSpec] Не удалось сохранить ${behavior.logLabel}`, {
                  changeId,
                  findingId: session.findingId,
                  code: errorCode(error),
                });
                try {
                  await updateNotificationLabel(activeAgent.id, true, request.signal);
                  notificationsDisabled = false;
                } catch (restoreError) {
                  logger.warn(`[OpenSpec] Не удалось восстановить ntfy ${behavior.logLabel}`, {
                    agentId: activeAgent.id,
                    code: errorCode(restoreError),
                  });
                }
                throw new McpToolError(
                  "Не удалось надёжно сохранить устранение finding; повторите вызов",
                );
              }

              completedResolution = verified;
              completion.resolve(verified);
              return completionToolResult(verified, behavior.completionLabel);
            } finally {
              combined.dispose();
            }
          }),
      });
      const scope = host.expose({ [behavior.toolName]: tool });

      try {
        const config = scope.configureAgent({
          provider: `${request.profile.provider}/${request.profile.model}`,
          modeId: request.profile.modeId,
          thinkingOptionId: request.profile.thinkingOptionId,
          ...(request.profile.featureValues == null
            ? {}
            : { featureValues: request.profile.featureValues }),
        });
        agent = await options.createAgent({
          config,
          title: behavior.agentTitle(session.findingId),
          prompt: behavior.prompt({
            changeId,
            findingId: session.findingId,
            branch,
            reviewRepositoryPath: context.reviewRepositoryPath,
            alreadyCommitted: resolutionAlreadyCommitted,
          }),
          labels: { ntfy: "true" },
        });
        throwIfSignalAborted(request.signal);
        request.onAgentCreated(agent.id);
        agentReady.resolve(agent);

        const resolution = await completion.promise;
        await new Promise<void>((resolveDrain) => setImmediate(resolveDrain));
        try {
          await agent.waitForFinish(agentDrainTimeoutMs);
        } catch (error) {
          logger.warn(`[OpenSpec] Не удалось дождаться завершения ${behavior.logLabel}`, {
            agentId: agent.id,
            code: errorCode(error),
          });
        }
        return resolution;
      } finally {
        request.signal.removeEventListener("abort", abortCompletion);
        if (agent && !notificationsDisabled) {
          try {
            await updateNotificationLabel(agent.id, false);
            notificationsDisabled = true;
          } catch (error) {
            logger.warn(`[OpenSpec] Не удалось отключить ntfy при закрытии ${behavior.logLabel}`, {
              agentId: agent.id,
              code: errorCode(error),
            });
          }
        }
        await scope.close().catch((error) => {
          logger.warn(`[OpenSpec] Не удалось закрыть MCP scope ${behavior.logLabel}`, {
            code: errorCode(error),
          });
        });
        await host.close().catch((error) => {
          logger.warn(`[OpenSpec] Не удалось закрыть MCP-хост ${behavior.logLabel}`, {
            code: errorCode(error),
          });
        });
      }
    },
  };
}

async function pathExists(
  inspectPath: typeof lstat,
  path: string,
  reportFileName: string,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfOptionalSignalAborted(signal);
  try {
    await inspectPath(path);
    throwIfOptionalSignalAborted(signal);
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw new ReviewFindingResolutionError(
      `Не удалось проверить наличие отчёта ${reportFileName}`,
    );
  }
}

async function isLocalResolutionReady<Session extends ReviewFindingResolutionSession>(
  command: BoundedCommandRunner,
  context: FindingResolutionContext,
  session: Session,
  behavior: ReviewFindingResolutionBehavior<Session>,
  readReport: (
    context: FindingResolutionContext,
    signal?: AbortSignal,
  ) => Promise<ActiveReviewFindingReport>,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await verifyLocalResolution(command, context, session, behavior, readReport, signal);
    return true;
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
}

async function verifyCompletedResolution<Session extends ReviewFindingResolutionSession>(
  command: BoundedCommandRunner,
  context: FindingResolutionContext,
  session: Session,
  behavior: ReviewFindingResolutionBehavior<Session>,
  readReport: (
    context: FindingResolutionContext,
    signal?: AbortSignal,
  ) => Promise<ActiveReviewFindingReport>,
  signal: AbortSignal,
): Promise<CompletedReviewFindingResolution> {
  const resolution = await verifyLocalResolution(
    command,
    context,
    session,
    behavior,
    readReport,
    signal,
  );
  await assertRemoteHead(command, context.gitRoot, session.branch, resolution.commit, signal);
  return resolution;
}

async function verifyLocalResolution<Session extends ReviewFindingResolutionSession>(
  command: BoundedCommandRunner,
  context: FindingResolutionContext,
  session: Session,
  behavior: ReviewFindingResolutionBehavior<Session>,
  readReport: (
    context: FindingResolutionContext,
    signal?: AbortSignal,
  ) => Promise<ActiveReviewFindingReport>,
  signal: AbortSignal,
): Promise<CompletedReviewFindingResolution> {
  await assertCurrentBranch(command, context.gitRoot, session.branch, signal);
  await assertCleanWorktree(command, context.gitRoot, signal);
  const report = await readReport(context, signal);
  if (report.findings.some(({ id }) => id === session.findingId)) {
    throw new ReviewFindingResolutionError(
      `Finding «${session.findingId}» всё ещё присутствует в ${behavior.reportFileName}`,
    );
  }
  await assertReviewTracked(command, context, behavior.reportFileName, signal);
  const head = await readHeadCommit(command, context.gitRoot, signal);
  await assertDescendsFromBaseline(
    command,
    context.gitRoot,
    session.baselineCommit,
    signal,
  );

  const commitCount = await readCommitCount(
    command,
    context.gitRoot,
    session.baselineCommit,
    head,
    signal,
  );
  if (commitCount !== 1) {
    throw new ReviewFindingResolutionError(
      `Для finding «${session.findingId}» требуется ровно один отдельный Git-коммит`,
    );
  }

  const changedPaths = await readDiffPaths(
    command,
    context.gitRoot,
    session.baselineCommit,
    head,
    signal,
  );
  const allowedPrefix = `${context.changeRepositoryPath}/`;
  if (
    changedPaths.length === 0 ||
    !changedPaths.includes(context.reviewRepositoryPath) ||
    changedPaths.some((path) => !path.startsWith(allowedPrefix))
  ) {
    throw new ReviewFindingResolutionError(
      `Finding-коммит должен изменять ${behavior.reportFileName} и только файлы выбранного change`,
    );
  }

  const subject = await readCommitSubject(command, context.gitRoot, head, signal);
  const expectedSubject = behavior.commitSubject(session.findingId);
  if (subject !== expectedSubject) {
    throw new ReviewFindingResolutionError(
      `Git-коммит finding должен иметь сообщение «${expectedSubject}»`,
    );
  }

  return {
    changeId: context.changeId,
    findingId: session.findingId,
    remainingFindingIds: Object.freeze(report.findings.map(({ id }) => id)),
    commit: head,
  };
}

async function assertCleanWorktree(
  command: BoundedCommandRunner,
  gitRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await command(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: gitRoot, signal },
    );
    if (result.stdout.length > 0) {
      throw new ReviewFindingResolutionError(
        "Рабочее дерево Git содержит незакоммиченные или неотслеживаемые изменения",
      );
    }
  } catch (error) {
    if (error instanceof ReviewFindingResolutionError || signal?.aborted) throw error;
    throw new ReviewFindingResolutionError(
      "Не удалось проверить чистоту рабочего дерева Git",
    );
  }
}

async function assertCurrentBranch(
  command: BoundedCommandRunner,
  gitRoot: string,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await command("git", ["branch", "--show-current"], {
      cwd: gitRoot,
      signal,
    });
    const current = findingResolutionBranchSchema.parse(result.stdout);
    if (current !== branch) {
      throw new ReviewFindingResolutionError(
        `Текущая Git-ветка изменилась с «${branch}» на «${current}»`,
      );
    }
  } catch (error) {
    if (error instanceof ReviewFindingResolutionError || signal?.aborted) throw error;
    throw new ReviewFindingResolutionError("Не удалось подтвердить текущую Git-ветку");
  }
}

async function readHeadCommit(
  command: BoundedCommandRunner,
  gitRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["rev-parse", "HEAD"], { cwd: gitRoot, signal });
    return commitHashSchema.parse(result.stdout.trim());
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ReviewFindingResolutionError("Не удалось определить текущий Git HEAD");
  }
}

async function assertReviewTracked(
  command: BoundedCommandRunner,
  context: FindingResolutionContext,
  reportFileName: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await command("git", ["cat-file", "-e", `HEAD:${context.reviewRepositoryPath}`], {
      cwd: context.gitRoot,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ReviewFindingResolutionError(
      `${reportFileName} не добавлен в текущий Git HEAD`,
    );
  }
}

async function assertDescendsFromBaseline(
  command: BoundedCommandRunner,
  gitRoot: string,
  baselineCommit: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await command("git", ["merge-base", "--is-ancestor", baselineCommit, "HEAD"], {
      cwd: gitRoot,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ReviewFindingResolutionError(
      "Текущий Git HEAD больше не продолжает baseline finding-сессии",
    );
  }
}

async function readCommitCount(
  command: BoundedCommandRunner,
  gitRoot: string,
  baselineCommit: string,
  head: string,
  signal: AbortSignal,
): Promise<number> {
  try {
    const result = await command(
      "git",
      ["rev-list", "--count", `${baselineCommit}..${head}`],
      { cwd: gitRoot, signal },
    );
    return z.coerce.number().int().nonnegative().parse(result.stdout.trim());
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ReviewFindingResolutionError("Не удалось проверить историю Git finding");
  }
}

async function readDiffPaths(
  command: BoundedCommandRunner,
  gitRoot: string,
  baselineCommit: string,
  head: string,
  signal: AbortSignal,
): Promise<string[]> {
  try {
    const result = await command(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${baselineCommit}..${head}`],
      { cwd: gitRoot, signal },
    );
    return result.stdout.split("\0").filter(Boolean);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ReviewFindingResolutionError(
      "Не удалось проверить состав Git-коммита finding",
    );
  }
}

async function readCommitSubject(
  command: BoundedCommandRunner,
  gitRoot: string,
  head: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const result = await command("git", ["log", "-1", "--format=%s", head], {
      cwd: gitRoot,
      signal,
    });
    return result.stdout.trim();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ReviewFindingResolutionError(
      "Не удалось проверить сообщение Git-коммита finding",
    );
  }
}

async function assertRemoteHead(
  command: BoundedCommandRunner,
  gitRoot: string,
  branch: string,
  expectedHead: string,
  signal?: AbortSignal,
): Promise<void> {
  const ref = `refs/heads/${branch}`;
  try {
    const result = await command(
      "git",
      ["ls-remote", "--exit-code", "--heads", REVIEW_REMOTE, ref],
      { cwd: gitRoot, signal },
    );
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (lines.length !== 1) throw new Error("Неоднозначный remote ref");
    const [hash, reportedRef, extra] = lines[0]?.split("\t") ?? [];
    if (
      extra !== undefined ||
      reportedRef !== ref ||
      commitHashSchema.parse(hash) !== expectedHead
    ) {
      throw new Error("Remote HEAD не совпадает");
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ReviewFindingResolutionError(
      `Git remote origin не содержит текущий HEAD ветки «${branch}»`,
    );
  }
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
  };
} {
  return {
    text: `${completionLabel} «${resolution.findingId}» устранена и опубликована`,
    data: {
      ...resolution,
      remainingFindingIds: [...resolution.remainingFindingIds],
    },
  };
}

function parseChangeId(changeId: string): string {
  const parsed = openSpecChangeIdSchema.safeParse(changeId);
  if (!parsed.success) {
    throw new ReviewFindingResolutionError("Change ID должен быть в kebab-case");
  }
  return parsed.data;
}

function parseBranch(branch: string): string {
  const parsed = findingResolutionBranchSchema.safeParse(branch);
  if (!parsed.success) {
    throw new ReviewFindingResolutionError(
      "Для устранения finding требуется безопасное имя non-main Git-ветки",
    );
  }
  return parsed.data;
}

function throwIfOptionalSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}
