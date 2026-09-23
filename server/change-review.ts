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
  ChangeReviewError,
  pendingReviewSessionSchema,
  reviewCommitSubject,
  reviewPublicationTarget,
  type CompletedChangeReview,
  type PendingReviewSession,
} from "./change-review-model.ts";
import {
  ChangeReviewPublicationError,
  assertReviewPublicationRecovery,
  prepareReviewPublication,
} from "./change-review-publication.ts";
import { planningBranchSchema } from "./change-branch.ts";
import {
  createChangeReviewVerification,
  type ChangeReviewVerificationOptions,
} from "./change-review-verification.ts";
import { createManagedAgentSession } from "./managed-agent-session.ts";
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

export {
  ChangeReviewError,
  pendingReviewSessionSchema,
  reviewCommitSubject,
} from "./change-review-model.ts";
export type {
  CompletedChangeReview,
  PendingReviewSession,
} from "./change-review-model.ts";

type PaseoApi = PluginHandlerContext["paseo"];
type PaseoWorkspace = ReturnType<PaseoApi["workspaces"]["ref"]>;
type PaseoAgent = Awaited<ReturnType<PaseoWorkspace["agents"]["create"]>>;

export type ReviewPaseoAgentCreator = (
  options: Parameters<PaseoWorkspace["agents"]["create"]>[0],
) => Promise<PaseoAgent>;

const DEFAULT_AGENT_DRAIN_TIMEOUT_MS = 15_000;
const MAX_PATH_LENGTH = 8_192;

export interface ChangeReviewRequest {
  readonly workspaceDirectory: string;
  readonly profile: CompleteRequiredAgentProfile;
  readonly session: PendingReviewSession;
  readonly signal: AbortSignal;
  readonly onAgentCreated: (agentId: string) => void;
}

export interface ChangeReviewService {
  plan(
    workspaceDirectory: string,
    changeId: string,
    changeBranch: string,
    activeBranch: string,
    phaseNumber: number | null,
    signal?: AbortSignal,
  ): Promise<PendingReviewSession>;
  run(request: ChangeReviewRequest): Promise<CompletedChangeReview>;
}

interface McpHostFactory {
  listen(): Promise<OrchestratorMcpToolHost>;
}

export interface ChangeReviewServiceOptions {
  readonly createAgent: ReviewPaseoAgentCreator;
  readonly command?: BoundedCommandRunner;
  readonly resolveRealPath?: ChangeReviewVerificationOptions["resolveRealPath"];
  readonly inspectPath?: ChangeReviewVerificationOptions["inspectPath"];
  readonly updateNotificationLabel?: AgentNotificationLabelUpdater;
  readonly mcpHost?: McpHostFactory;
  readonly agentDrainTimeoutMs?: number;
  readonly logger?: Pick<Console, "error" | "warn">;
}

export function createChangeReviewService(
  options: ChangeReviewServiceOptions,
): ChangeReviewService {
  const command = options.command ?? runBoundedCommand;
  const verification = createChangeReviewVerification({
    command,
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

  return {
    async plan(workspaceDirectory, changeId, changeBranch, activeBranch, phaseNumber, signal) {
      const context = await verification.readContext(
        workspaceDirectory,
        changeId,
        signal,
      );
      const target = await prepareReviewPublication(
        context.gitRoot,
        context.changeId,
        changeBranch,
        activeBranch,
        signal,
        command,
      );
      return pendingReviewSessionSchema.parse({
        changeId: context.changeId,
        phaseNumber,
        ...target,
      });
    },

    async run(request) {
      throwIfSignalAborted(request.signal);
      const session = pendingReviewSessionSchema.parse(request.session);
      const changeId = session.changeId;
      const publicationTarget = reviewPublicationTarget(session);

      const context = await verification.readContext(
        request.workspaceDirectory,
        changeId,
        request.signal,
      );
      await assertReviewPublicationRecovery(
        context.gitRoot,
        publicationTarget,
        changeId,
        request.signal,
        command,
      );

      const reviewAlreadyCommitted = await verification.isLocalCommitReady(
        context,
        session,
        request.signal,
      );
      const host = await mcpHost.listen();
      let completedReview: CompletedChangeReview | null = null;
      const agentSession = createManagedAgentSession<CompletedChangeReview>({
        signal: request.signal,
        host,
        updateNotificationLabel,
        agentDrainTimeoutMs,
        logContext: "review change",
        logger,
      });

      const outputSchema = z
        .object({
          changeId: openSpecChangeIdSchema,
          reviewPath: z.string().trim().min(1).max(MAX_PATH_LENGTH),
          branch: planningBranchSchema,
          pullRequest: z
            .object({
              number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
              url: z.string().url().max(2_048),
              title: z.string().trim().min(1).max(256),
            })
            .strict(),
        })
        .strict();
      const scope = await agentSession.openScope(() => host.expose({
        complete_change_review: defineMcpTool({
          description:
            "Проверить законченный, закоммиченный и опубликованный review выбранного OpenSpec change",
          inputSchema: z.object({}).strict(),
          outputSchema,
          execute: (_input, toolContext) =>
            agentSession.runExclusive(async () => {
              if (completedReview) return completionToolResult(completedReview);
              const combined = combineAbortSignals(request.signal, toolContext.signal);
              const { signal } = combined;
              try {
                const activeAgent = await agentSession.waitForAgent(signal);
                let verified: CompletedChangeReview;
                try {
                  verified = await verification.verifyCompleted(
                    context,
                    session,
                    signal,
                  );
                } catch (error) {
                  if (
                    error instanceof ChangeReviewError ||
                    error instanceof ChangeReviewPublicationError
                  ) {
                    throw new McpToolError(error.message);
                  }
                  if (signal.aborted) throw error;
                  logger.error("[OpenSpec] Не удалось проверить review change", {
                    changeId,
                    code: errorCode(error),
                  });
                  throw new McpToolError("Не удалось проверить review выбранного change");
                }

                try {
                  await agentSession.disableNotifications(signal);
                } catch (error) {
                  if (signal.aborted) throw error;
                  logger.error("[OpenSpec] Не удалось отключить ntfy для review-агента", {
                    agentId: activeAgent.id,
                    code: errorCode(error),
                  });
                  throw new McpToolError(
                    "Не удалось отключить финальное уведомление агента; повторите вызов",
                  );
                }

                completedReview = verified;
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
        await agentSession.launchAgent(
          () =>
            options.createAgent({
              config,
              title: `Review OpenSpec change: ${changeId}`,
              prompt: changeReviewPrompt({
                changeId,
                parentBranch: session.parentBranch,
                reviewBranch: session.reviewBranch,
                parentBaselineCommit: session.parentBaselineCommit,
                baselineCommit: session.baselineCommit,
                phaseNumber: session.phaseNumber,
                repository:
                  session.repositoryHost === "github.com"
                    ? session.repositoryNameWithOwner
                    : `${session.repositoryHost}/${session.repositoryNameWithOwner}`,
                reviewRepositoryPath: context.reviewRepositoryPath,
                alreadyCommitted: reviewAlreadyCommitted,
              }),
              labels: { ntfy: "true" },
            }),
          request.onAgentCreated,
        );

        const review = await agentSession.waitForCompletion();
        // Completion разрешается внутри MCP handler. Даём transport закончить
        // отправку ответа до возможного мгновенного waitForFinish и закрытия scope.
        await new Promise<void>((resolveDrain) => setImmediate(resolveDrain));
        await agentSession.drainAgent();
        return review;
      } finally {
        await agentSession.close();
      }
    },
  };
}

export function changeReviewPrompt(input: {
  readonly changeId: string;
  readonly parentBranch: string;
  readonly reviewBranch: string;
  readonly parentBaselineCommit: string;
  readonly baselineCommit: string;
  readonly phaseNumber: number | null;
  readonly repository: string;
  readonly reviewRepositoryPath: string;
  readonly alreadyCommitted: boolean;
}): string {
  const phaseNumber = input.phaseNumber;
  const subject = reviewCommitSubject(input.changeId);
  const reviewInstruction = input.alreadyCommitted
    ? "This is a recovery session: the finished review is already committed. Do not invoke the review skill again and do not create or amend a commit; complete the stage."
    : phaseNumber === null
      ? `Invoke the \`openspec-review-change\` skill for change \`${input.changeId}\` and let it produce a finished \`review.md\` in the reported change root.`
      : `Invoke the \`openspec-review-change\` skill for change \`${input.changeId}\` in task-planning review mode focused exclusively on Phase ${phaseNumber}: check that the newly planned ${phaseNumber}.* tasks implement that phase of plan.md completely and without contradicting the other planning artifacts or the preserved tasks. Record all findings, or their absence, in a finished \`review.md\`.`;

  return buildAgentPrompt({
    role: "You own the review stage of one OpenSpec change.",
    communication: "interactive",
    workflowData: {
      changeId: input.changeId,
      parentBranch: input.parentBranch,
      reviewBranch: input.reviewBranch,
      parentBaselineCommit: input.parentBaselineCommit,
      baselineCommit: input.baselineCommit,
      repository: input.repository,
      remote: "origin",
      reviewPath: input.reviewRepositoryPath,
      commitSubject: subject,
      alreadyCommitted: input.alreadyCommitted,
    },
    rules: [
      OPENSPEC_CLI_RULE,
      NO_GITHUB_RULE,
      FIXED_BRANCH_RULE,
      STAGE_SCOPE_RULE,
    ],
    body: [
      "The root change branch is already published. Verify that it still descends from the saved baseline.",
      reviewInstruction,
      "Findings do not block this stage: never fix findings, implementation code, or existing planning artifacts, because a later stage owns them. If the review cannot be finished or needs user input, say what is missing and keep the conversation in this session instead of completing the stage.",
      `Keep \`review.md\` and any other file the skill creates inside the change root, materially update an existing \`review.md\`, stage only those files, and create exactly one commit with subject \`${subject}\`. Leave every other pre-existing file, including the planning artifacts, untouched, and do not amend or delete files.`,
      "Do not push or create a pull request. The orchestrator verifies and publishes the review commit to the existing Draft root pull request.",
    ],
    completion: completionInstruction({
      tool: "complete_change_review",
      retryScope: "the review commit or its publication state",
    }),
  });
}

function completionToolResult(review: CompletedChangeReview): {
  readonly text: string;
  readonly data: CompletedChangeReview;
} {
  return {
    text: `Review change «${review.changeId}» принят и опубликован`,
    data: review,
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}
