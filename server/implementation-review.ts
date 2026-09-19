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
import { combineAbortSignals, throwIfSignalAborted } from "./agent-session-control.ts";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { commitHashSchema } from "./change-artifact-model.ts";
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
  type ImplementationRun,
} from "./implementation-run-model.ts";
import {
  readImplementationReviewContext,
  type ImplementationReviewContext,
} from "./implementation-review-context.ts";
import {
  reconcileDraftImplementationPullRequest,
} from "./implementation-publication.ts";
import { createManagedAgentSession } from "./managed-agent-session.ts";
import { McpToolError, OrchestratorMcpToolHost, defineMcpTool } from "./orchestrator-mcp-tool-host.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";
import { updateAgentNotificationLabel, type AgentNotificationLabelUpdater } from "./paseo-agent-labels.ts";
import { ChangeReviewPublicationError } from "./review-publication-model.ts";

const REVIEW_SKILL = "openspec-review-implementation";
const DEFAULT_AGENT_DRAIN_TIMEOUT_MS = 15_000;

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

export function implementationReviewCommitSubject(): string {
  return "docs(openspec): review implementation batch";
}

export function createImplementationReviewService(
  options: ImplementationReviewServiceOptions,
): ImplementationReviewService {
  const command = options.command ?? runBoundedCommand;
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
      if (!sameStrings(commits, run.batch.tasks.map(({ commit }) => commit))) {
        throw new ImplementationReviewError(
          "Task-коммиты пакета не совпадают с точным Git-диапазоном review",
        );
      }
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
      const alreadyCommitted = await inspectExistingReviewCommit(
        command,
        context,
        session,
        request.signal,
      );
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
            "Проверить точный implementation-диапазон, review-коммит, push и единый Draft PR",
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
                  combined.signal,
                );
                const pullRequest = await reconcileDraftImplementationPullRequest(
                  command,
                  context.gitRoot,
                  { ...run, lastDeliveryHead: session.reviewedHead },
                  local.reviewCommit,
                  combined.signal,
                );
                verified = {
                  ...local,
                  pullRequest: {
                    number: pullRequest.number,
                    url: pullRequest.url,
                    title: pullRequest.title,
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
          reviewRepositoryPath: context.reviewRepositoryPath,
          alreadyCommitted,
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
  readonly reviewRepositoryPath: string;
  readonly alreadyCommitted: boolean;
}): string {
  const { session } = input;
  const subject = implementationReviewCommitSubject();
  const reviewInstruction = input.alreadyCommitted
    ? "This is a recovery session: the complete report commit already exists. Do not invoke the review skill, edit files, or create or amend a commit."
    : `Invoke \`openspec-review-implementation\` for the exact immutable range \`${session.baseCommit}..${session.reviewedHead}\` and change \`${session.changeId}\`. Review every listed task commit and map every task to at least one review unit.`;
  const commitInstruction = input.alreadyCommitted
    ? ""
    : `When the report is complete and format-valid, stage only the report and create exactly one commit after the reviewed head with subject \`${subject}\`.`;

  return buildAgentPrompt({
    role: "You own one bounded implementation-review stage.",
    communication: "blocker-only",
    workflowData: {
      changeId: session.changeId,
      branch: session.implementationBranch,
      baseCommit: session.baseCommit,
      reviewedHead: session.reviewedHead,
      targetCommits: session.tasks.map(({ commit }) => commit),
      tasks: session.tasks,
      reviewPath: input.reviewRepositoryPath,
      commitSubject: subject,
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
      reviewInstruction,
      `The report needs complete coverage and the exact Base commit, Reviewed head, and ordered Target commits from the workflow data. Modify only \`${input.reviewRepositoryPath}\`: never fix findings or implementation and never change task state.`,
      commitInstruction,
      `Push \`${session.implementationBranch}\` to origin.`,
    ],
    completion: completionInstruction({
      tool: "complete_implementation_review",
      retryScope: "the report commit or its push",
    }),
  });
}

async function inspectExistingReviewCommit(
  command: BoundedCommandRunner,
  context: ImplementationReviewContext,
  session: PendingImplementationReviewSession,
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
        "Origin implementation-ветки не совпадает с reviewed head",
      );
    }
    return false;
  }
  await verifyCompletedReview(command, context, session, signal, false);
  return true;
}

async function verifyCompletedReview(
  command: BoundedCommandRunner,
  context: ImplementationReviewContext,
  session: PendingImplementationReviewSession,
  signal: AbortSignal,
  requireRemote = true,
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
  if (commitCount !== 1) {
    throw new ImplementationReviewError(
      "После reviewed head требуется ровно один implementation review commit",
    );
  }
  const changedPaths = await readTaskChangedPaths(
    command,
    context.gitRoot,
    session.reviewedHead,
    head,
    signal,
  );
  if (!sameStrings(changedPaths, [context.reviewRepositoryPath])) {
    throw new ImplementationReviewError(
      "Implementation review commit должен изменять только implementation-review.md",
    );
  }
  const subject = (
    await command("git", ["log", "-1", "--format=%s", head], {
      cwd: context.gitRoot,
      signal,
    })
  ).stdout.trim();
  if (subject !== implementationReviewCommitSubject()) {
    throw new ImplementationReviewError(
      `Review commit должен иметь subject «${implementationReviewCommitSubject()}»`,
    );
  }
  const remoteHead = await readRemoteTaskBranchCommit(
    command,
    context.gitRoot,
    session.implementationBranch,
    signal,
  );
  if (
    (requireRemote && remoteHead !== head) ||
    (!requireRemote && remoteHead !== session.reviewedHead && remoteHead !== head)
  ) {
    throw new ImplementationReviewError(
      requireRemote
        ? "Origin не содержит implementation review commit"
        : "Origin implementation-ветки содержит неожиданный commit",
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
      "Origin implementation-ветки не совпадает с reviewed head пакета",
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
      `Текущей должна быть implementation-ветка «${session.implementationBranch}»`,
    );
  }
  if (localRoot !== session.rootBaselineCommit || remoteRoot !== session.rootBaselineCommit) {
    throw new ImplementationReviewError("Root baseline изменился во время implementation review");
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
