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
  abortError,
  combineAbortSignals,
  throwIfSignalAborted,
} from "./agent-session-control.ts";
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-command.ts";
import {
  inspectPublicationTarget,
  publishPublication,
} from "./change-publication-gateway.ts";
import {
  ChangePublicationError,
  PUBLICATION_BASE_BRANCH,
  PUBLICATION_REMOTE,
  publicationCompletionInputSchema,
  publicationCompletionOutputSchema,
  type PublicationTarget,
  type PublishedPullRequest,
} from "./change-publication-model.ts";
import {
  changeBranchFor,
  changeBranchSchema,
} from "./change-branch.ts";
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

export { ChangePublicationError } from "./change-publication-model.ts";
export type { PublishedPullRequest } from "./change-publication-model.ts";

type PaseoApi = PluginHandlerContext["paseo"];
type PaseoWorkspace = ReturnType<PaseoApi["workspaces"]["ref"]>;
type PaseoAgent = Awaited<ReturnType<PaseoWorkspace["agents"]["create"]>>;

export type PublicationPaseoAgentCreator = (
  options: Parameters<PaseoWorkspace["agents"]["create"]>[0],
) => Promise<PaseoAgent>;

const DEFAULT_AGENT_DRAIN_TIMEOUT_MS = 15_000;

export interface ChangePublicationRequest {
  readonly workspaceDirectory: string;
  readonly changeId: string;
  readonly changeBranch: string;
  readonly activeBranch: string;
  readonly profile: CompleteRequiredAgentProfile;
  readonly signal: AbortSignal;
  readonly onAgentCreated: (agentId: string) => void;
}

export interface ChangePublicationService {
  publish(request: ChangePublicationRequest): Promise<PublishedPullRequest>;
}

interface McpHostFactory {
  listen(): Promise<OrchestratorMcpToolHost>;
}

export interface ChangePublicationServiceOptions {
  readonly createAgent: PublicationPaseoAgentCreator;
  readonly command?: BoundedCommandRunner;
  readonly updateNotificationLabel?: AgentNotificationLabelUpdater;
  readonly mcpHost?: McpHostFactory;
  readonly agentDrainTimeoutMs?: number;
  readonly logger?: Pick<Console, "error" | "warn">;
}

export function createChangePublicationService(
  options: ChangePublicationServiceOptions,
): ChangePublicationService {
  const command = options.command ?? runBoundedCommand;
  const updateNotificationLabel =
    options.updateNotificationLabel ?? updateAgentNotificationLabel;
  const mcpHost = options.mcpHost ?? OrchestratorMcpToolHost;
  const agentDrainTimeoutMs =
    options.agentDrainTimeoutMs ?? DEFAULT_AGENT_DRAIN_TIMEOUT_MS;
  const logger = options.logger ?? console;

  return {
    async publish(request) {
      throwIfSignalAborted(request.signal);
      const parsedChangeId = openSpecChangeIdSchema.safeParse(request.changeId);
      if (!parsedChangeId.success) {
        throw new ChangePublicationError("Change ID не соответствует kebab-case");
      }
      const parsedChangeBranch = changeBranchSchema.safeParse(request.changeBranch);
      if (
        !parsedChangeBranch.success ||
        parsedChangeBranch.data !== changeBranchFor(parsedChangeId.data) ||
        request.activeBranch !== parsedChangeBranch.data
      ) {
        throw new ChangePublicationError(
          "Для публикации требуется активная корневая ветка change/<id>",
        );
      }
      const changeId = parsedChangeId.data;
      const changeBranch = parsedChangeBranch.data;
      const activeBranch = parsedChangeBranch.data;
      const target = await inspectPublicationTarget(
        command,
        request.workspaceDirectory,
        changeBranch,
        activeBranch,
        request.signal,
      );
      throwIfSignalAborted(request.signal);

      const host = await mcpHost.listen();
      if (request.signal.aborted) {
        await host.close().catch((error) => {
          logger.warn("[OpenSpec] Не удалось закрыть MCP-хост отменённой публикации", {
            code: errorCode(error),
          });
        });
        throw abortError();
      }
      let published: PublishedPullRequest | null = null;
      const agentSession = createManagedAgentSession<PublishedPullRequest>({
        signal: request.signal,
        host,
        updateNotificationLabel,
        agentDrainTimeoutMs,
        logContext: "публикация change",
        logger,
      });

      const scope = await agentSession.openScope(() => host.expose({
        complete_change_publication: defineMcpTool({
          description:
            "Опубликовать подготовленные название и описание в интеграционном pull request выбранного OpenSpec change",
          inputSchema: publicationCompletionInputSchema,
          outputSchema: publicationCompletionOutputSchema,
          execute: (input, toolContext) =>
            agentSession.runExclusive(async () => {
              if (published) {
                return completionToolResult(published);
              }

              const combined = combineAbortSignals(request.signal, toolContext.signal);
              const { signal } = combined;
              try {
                const activeAgent = await agentSession.waitForAgent(signal);
                let verified: PublishedPullRequest;
                try {
                  verified = await publishPublication(command, {
                    workspaceDirectory: request.workspaceDirectory,
                    changeId,
                    changeBranch,
                    activeBranch,
                    target,
                    input,
                    signal,
                  });
                } catch (error) {
                  if (error instanceof ChangePublicationError) {
                    throw new McpToolError(error.message);
                  }
                  if (signal.aborted) throw error;
                  logger.error("[OpenSpec] Не удалось проверить публикацию change", {
                    changeId,
                    code: errorCode(error),
                  });
                  throw new McpToolError("Не удалось проверить публикацию change");
                }

                try {
                  await agentSession.disableNotifications(signal);
                } catch (error) {
                  if (signal.aborted) throw error;
                  logger.error("[OpenSpec] Не удалось отключить ntfy для агента публикации", {
                    agentId: activeAgent.id,
                    code: errorCode(error),
                  });
                  throw new McpToolError(
                    "Не удалось отключить финальное уведомление агента; повторите вызов",
                  );
                }

                published = verified;
                agentSession.complete(verified);
                return completionToolResult(verified);
              } finally {
                combined.dispose();
              }
            }),
        }),
      }));

      try {
        throwIfSignalAborted(request.signal);
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
              title: `Публикация OpenSpec change: ${changeId}`,
              prompt: changePublicationPrompt({
                changeId,
                changeBranch,
                activeBranch,
                target,
              }),
              labels: { ntfy: "true" },
            }),
          request.onAgentCreated,
        );

        const publication = await agentSession.waitForCompletion();
        // Completion разрешается внутри MCP handler. Даём transport закончить
        // отправку ответа до возможного мгновенного waitForFinish и закрытия scope.
        await new Promise<void>((resolveDrain) => setImmediate(resolveDrain));
        await agentSession.drainAgent();
        return publication;
      } finally {
        await agentSession.close();
      }
    },
  };
}

export function changePublicationPrompt(input: {
  readonly changeId: string;
  readonly changeBranch: string;
  readonly activeBranch: string;
  readonly target: PublicationTarget;
}): string {
  const pullRequestNumber = input.target.existingPullRequest.number;
  return buildAgentPrompt({
    role:
      "You own the publication stage: turn the completed planning artifacts into the text of the existing root pull request.",
    communication: "blocker-only",
    workflowData: {
      changeId: input.changeId,
      changeBranch: input.changeBranch,
      activeBranch: input.activeBranch,
      remote: PUBLICATION_REMOTE,
      baseBranch: PUBLICATION_BASE_BRANCH,
      repository: input.target.repository,
      existingOpenPullRequest: pullRequestNumber,
    },
    rules: [
      OPENSPEC_CLI_RULE,
      NO_GITHUB_RULE,
      FIXED_BRANCH_RULE,
      STAGE_SCOPE_RULE,
    ],
    body: [
      "1. Confirm the worktree is clean with `git status --porcelain=v1 --untracked-files=all`; if it is not, stop without changing anything.",
      `2. Run \`mise exec --no-deps -- openspec status --change ${input.changeId} --json\` and read every \`existingOutputPaths\` file of each done artifact. Read only regular files inside the reported change root and fail on any path that escapes it. Ignore skipped artifacts.`,
      "3. From those artifacts write a stable Russian title for the outcome of the whole change, using only letters, digits, spaces, and the punctuation `.,:«»—–/_-`. Leave out the change ID, branches, task numbers, artifact names, WIP/Draft markers, and anything else that changes while work continues.",
      `4. Write the Russian body with exactly these ordered sections: \`## Суть\`, \`## Ожидаемый результат\`, \`## Границы change\`, \`## OpenSpec change\`. Keep it high-level, omit task and commit progress, and put the exact change ID \`${input.changeId}\` in backticks in the final section.`,
      "5. Do not push or create a commit. The orchestrator verifies and publishes the current root HEAD after completion.",
      `6. Do not modify root pull request #${pullRequestNumber} or any other GitHub resource. The orchestrator owns pull-request mutation and will publish the title and body after validating them.`,
    ],
    completion: completionInstruction({
      tool: "complete_change_publication",
      argument: "that exact drafted title and body",
      retryScope: "the publication state",
    }),
  });
}

function completionToolResult(publication: PublishedPullRequest): {
  readonly text: string;
  readonly data: z.input<typeof publicationCompletionOutputSchema>;
} {
  return {
    text: `Pull request #${publication.number} опубликован: ${publication.url}`,
    data: {
      pullRequestNumber: publication.number,
      url: publication.url,
      title: publication.title,
    },
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String(Reflect.get(error, "code"));
  }
  return "unknown";
}
