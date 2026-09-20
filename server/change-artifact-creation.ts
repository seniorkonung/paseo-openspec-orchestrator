import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { CompleteRequiredAgentProfile } from "./agent-profiles.ts";
import {
  combineAbortSignals,
  throwIfSignalAborted,
} from "./agent-session-control.ts";
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-command.ts";
import {
  assertCleanWorktree,
  assertRecoverableCommitRange,
  readHeadCommit,
  verifyArtifactCommit,
} from "./change-artifact-git.ts";
import {
  ChangeArtifactCreationError,
  artifactCommitSubject,
  openSpecArtifactIdSchema,
  parseChangeId,
  pendingArtifactSessionSchema,
  type ChangeArtifactDecision,
  type ChangeArtifactPlan,
  type PendingArtifactSession,
} from "./change-artifact-model.ts";
import {
  createChangeArtifactStatusGateway,
  planArtifactStatus,
  type ChangeArtifactStatusGatewayOptions,
  type InspectedOpenSpecStatus,
} from "./change-artifact-status.ts";
import {
  OPENSPEC_CLI_RULE,
  STAGE_SCOPE_RULE,
  buildAgentPrompt,
  completionInstruction,
} from "./agent-prompt.ts";
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

type PaseoApi = PluginHandlerContext["paseo"];
type PaseoWorkspace = ReturnType<PaseoApi["workspaces"]["ref"]>;
type PaseoAgent = Awaited<ReturnType<PaseoWorkspace["agents"]["create"]>>;

export type ArtifactPaseoAgentCreator = (
  options: Parameters<PaseoWorkspace["agents"]["create"]>[0],
) => Promise<PaseoAgent>;

const DEFAULT_AGENT_DRAIN_TIMEOUT_MS = 15_000;
const CONTINUE_CHANGE_SKILL = "openspec-continue-change";

export {
  ChangeArtifactCreationError,
  openSpecArtifactIdSchema,
  pendingArtifactSessionSchema,
} from "./change-artifact-model.ts";
export type {
  ChangeArtifactDecision,
  ChangeArtifactPlan,
  PendingArtifactSession,
} from "./change-artifact-model.ts";

export interface ChangeArtifactCreationRequest {
  readonly workspaceDirectory: string;
  readonly changeId: string;
  readonly profile: CompleteRequiredAgentProfile;
  readonly session: PendingArtifactSession;
  readonly signal: AbortSignal;
  readonly onAgentCreated: (agentId: string) => void;
  readonly onArtifactCompleted: (plan: ChangeArtifactPlan) => Promise<void>;
}

export interface ChangeArtifactCreationService {
  inspect(
    workspaceDirectory: string,
    changeId: string,
    signal?: AbortSignal,
  ): Promise<ChangeArtifactDecision>;
  prepare(
    workspaceDirectory: string,
    changeId: string,
    signal?: AbortSignal,
  ): Promise<PendingArtifactSession>;
  create(request: ChangeArtifactCreationRequest): Promise<ChangeArtifactPlan>;
  verifyApply(
    workspaceDirectory: string,
    changeId: string,
    schemaName: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

interface McpHostFactory {
  listen(): Promise<OrchestratorMcpToolHost>;
}

export interface ChangeArtifactCreationServiceOptions {
  readonly createAgent: ArtifactPaseoAgentCreator;
  readonly command?: BoundedCommandRunner;
  readonly resolveRealPath?: ChangeArtifactStatusGatewayOptions["resolveRealPath"];
  readonly updateNotificationLabel?: AgentNotificationLabelUpdater;
  readonly mcpHost?: McpHostFactory;
  readonly agentDrainTimeoutMs?: number;
  readonly logger?: Pick<Console, "error" | "warn">;
}

export function createChangeArtifactCreationService(
  options: ChangeArtifactCreationServiceOptions,
): ChangeArtifactCreationService {
  const command = options.command ?? runBoundedCommand;
  const statusGateway = createChangeArtifactStatusGateway({
    command,
    ...(options.resolveRealPath == null
      ? {}
      : { resolveRealPath: options.resolveRealPath }),
  });
  const updateNotificationLabel =
    options.updateNotificationLabel ?? updateAgentNotificationLabel;
  const mcpHost = options.mcpHost ?? OrchestratorMcpToolHost;
  const agentDrainTimeoutMs =
    options.agentDrainTimeoutMs ?? DEFAULT_AGENT_DRAIN_TIMEOUT_MS;
  const logger = options.logger ?? console;

  return {
    inspect: statusGateway.inspect,
    async prepare(workspaceDirectory, changeId, signal) {
      const status = await statusGateway.read(workspaceDirectory, changeId, signal);
      const plan = planArtifactStatus(status);
      if (plan.kind !== "next-artifact") {
        throw new ChangeArtifactCreationError(
          `Все planning-артефакты change «${status.changeName}» уже созданы`,
        );
      }
      await assertCleanWorktree(command, status.gitRoot, signal);
      const baselineCommit = await readHeadCommit(command, status.gitRoot, signal);
      return {
        artifactId: plan.artifactId,
        schemaName: plan.schemaName,
        baselineCommit,
      };
    },
    async verifyApply(workspaceDirectory, changeId, schemaName, signal) {
      await statusGateway.verifyApply(
        workspaceDirectory,
        changeId,
        schemaName,
        signal,
      );
    },
    async create(request) {
      throwIfSignalAborted(request.signal);
      const parsedSession = pendingArtifactSessionSchema.parse(request.session);
      const before = await statusGateway.read(
        request.workspaceDirectory,
        request.changeId,
        request.signal,
      );
      const expectedArtifact = before.artifacts.get(parsedSession.artifactId);
      if (before.schemaName !== parsedSession.schemaName || !expectedArtifact) {
        throw new ChangeArtifactCreationError(
          `Schema или ожидаемый артефакт изменились после сохранения checkpoint`,
        );
      }
      if (expectedArtifact.status === "blocked" || expectedArtifact.status === "skipped") {
        throw new ChangeArtifactCreationError(
          `Артефакт «${parsedSession.artifactId}» больше нельзя создать на текущем этапе`,
        );
      }
      if (expectedArtifact.status === "ready") {
        const plan = planArtifactStatus(before);
        if (
          plan.kind !== "next-artifact" ||
          plan.artifactId !== parsedSession.artifactId
        ) {
          throw new ChangeArtifactCreationError(
            `OpenSpec изменил рекомендуемый следующий артефакт после сохранения checkpoint`,
          );
        }
        await assertCleanWorktree(command, before.gitRoot, request.signal);
        const currentHead = await readHeadCommit(command, before.gitRoot, request.signal);
        if (currentHead !== parsedSession.baselineCommit) {
          throw new ChangeArtifactCreationError(
            "Git HEAD изменился до начала создания ожидаемого артефакта",
          );
        }
      } else {
        await assertRecoverableCommitRange(
          command,
          before.gitRoot,
          parsedSession.baselineCommit,
          request.signal,
        );
      }

      const host = await mcpHost.listen();
      let completedPlan: ChangeArtifactPlan | null = null;
      const agentSession = createManagedAgentSession<ChangeArtifactPlan>({
        signal: request.signal,
        host,
        updateNotificationLabel,
        agentDrainTimeoutMs,
        logContext: "создание OpenSpec-артефакта",
        logger,
      });

      const outputSchema = z
        .object({
          artifactId: openSpecArtifactIdSchema,
          planningComplete: z.boolean(),
        })
        .strict();
      const scope = await agentSession.openScope(() => host.expose({
        complete_artifact: defineMcpTool({
          description:
            "Подтвердить одобренный пользователем и отдельно закоммиченный OpenSpec-артефакт",
          inputSchema: z.object({}).strict(),
          outputSchema,
          execute: (_input, toolContext) =>
            agentSession.runExclusive(async () => {
              if (completedPlan) {
                return completionToolResult(parsedSession.artifactId, completedPlan);
              }
              const combined = combineAbortSignals(request.signal, toolContext.signal);
              const { signal } = combined;
              try {
                const activeAgent = await agentSession.waitForAgent(signal);
                let after: InspectedOpenSpecStatus;
                let plan: ChangeArtifactPlan;
                try {
                  after = await statusGateway.read(
                    request.workspaceDirectory,
                    request.changeId,
                    signal,
                  );
                  if (after.schemaName !== parsedSession.schemaName) {
                    throw new ChangeArtifactCreationError(
                      "Schema change изменилась во время создания артефакта",
                    );
                  }
                  const artifact = after.artifacts.get(parsedSession.artifactId);
                  if (artifact?.status !== "done") {
                    throw new ChangeArtifactCreationError(
                      `Артефакт «${parsedSession.artifactId}» ещё не создан`,
                    );
                  }
                  await verifyArtifactCommit(
                    command,
                    after,
                    parsedSession,
                    signal,
                  );
                  plan = planArtifactStatus(after);
                } catch (error) {
                  if (error instanceof ChangeArtifactCreationError) {
                    throw new McpToolError(error.message);
                  }
                  if (signal.aborted) throw error;
                  logger.error("[OpenSpec] Не удалось проверить созданный артефакт", {
                    changeId: request.changeId,
                    artifactId: parsedSession.artifactId,
                    error,
                  });
                  throw new McpToolError("Не удалось проверить созданный артефакт");
                }

                try {
                  await agentSession.disableNotifications(signal);
                } catch (error) {
                  if (signal.aborted) throw error;
                  logger.error("[OpenSpec] Не удалось отключить ntfy для агента", {
                    agentId: activeAgent.id,
                    error,
                  });
                  throw new McpToolError(
                    "Не удалось отключить финальное уведомление агента; повторите вызов",
                  );
                }

                try {
                  await request.onArtifactCompleted(plan);
                } catch (error) {
                  logger.error("[OpenSpec] Не удалось сохранить завершение артефакта", {
                    changeId: request.changeId,
                    artifactId: parsedSession.artifactId,
                    error,
                  });
                  try {
                    await agentSession.restoreNotifications(signal);
                  } catch (restoreError) {
                    logger.warn("[OpenSpec] Не удалось восстановить ntfy после ошибки записи", {
                      agentId: activeAgent.id,
                      restoreError,
                    });
                  }
                  throw new McpToolError(
                    "Не удалось надёжно сохранить завершение артефакта; повторите вызов",
                  );
                }

                completedPlan = plan;
                agentSession.complete(plan);
                return completionToolResult(parsedSession.artifactId, plan);
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
              title: `Создание OpenSpec artifact: ${parsedSession.artifactId}`,
              labels: { ntfy: "true" },
            }),
          request.onAgentCreated,
        );

        const catalog = await agent.commands();
        if (catalog.error || !catalog.commands.some(({ name }) => name === CONTINUE_CHANGE_SKILL)) {
          throw new ChangeArtifactCreationError(
            `Агент не загрузил обязательный skill ${CONTINUE_CHANGE_SKILL}`,
          );
        }
        await agent.send(
          artifactCreationPrompt({
            changeId: parseChangeId(request.changeId),
            artifactId: parsedSession.artifactId,
            alreadyCreated: expectedArtifact.status === "done",
          }),
        );

        const plan = await agentSession.waitForCompletion();
        await agentSession.drainAgent();
        return plan;
      } finally {
        await agentSession.close();
      }
    },
  };
}

function artifactCreationPrompt(input: {
  readonly changeId: string;
  readonly artifactId: string;
  readonly alreadyCreated: boolean;
}): string {
  const commitSubject = artifactCommitSubject(input.artifactId);
  const creationInstruction = input.alreadyCreated
    ? `This is a recovery session: the expected artifact is \`${input.artifactId}\` and it already exists. Do not invoke the continue skill again and do not create the next artifact; only review this artifact with the user.`
    : `Invoke the \`${CONTINUE_CHANGE_SKILL}\` skill exactly once: the expected artifact is \`${input.artifactId}\` and the skill must create exactly it.`;

  return buildAgentPrompt({
    role: "You own one OpenSpec planning-artifact stage.",
    communication: "interactive",
    workflowData: {
      changeId: input.changeId,
      artifactId: input.artifactId,
      commitSubject,
      alreadyCreated: input.alreadyCreated,
    },
    rules: [OPENSPEC_CLI_RULE, STAGE_SCOPE_RULE],
    body: [
      creationInstruction,
      "Show the artifact to the user and ask whether they explicitly approve finishing this stage. While they ask for changes, revise only this artifact and ask again.",
      `After approval, run \`mise exec --no-deps -- openspec status --change ${input.changeId} --json\`, stage exactly the files listed in \`artifactPaths.${input.artifactId}.existingOutputPaths\`, and create one commit with subject \`${commitSubject}\`. Do not touch another artifact, implement tasks, or amend unrelated files.`,
    ],
    completion: completionInstruction({
      tool: "complete_artifact",
      retryScope: "the expected artifact or its commit",
    }),
  });
}

function completionToolResult(
  artifactId: string,
  plan: ChangeArtifactPlan,
): {
  readonly text: string;
  readonly data: { readonly artifactId: string; readonly planningComplete: boolean };
} {
  const planningComplete = plan.kind === "complete";
  return {
    text: planningComplete
      ? `Артефакт «${artifactId}» принят; все planning-артефакты созданы`
      : `Артефакт «${artifactId}» принят; workflow создаст следующий артефакт`,
    data: { artifactId, planningComplete },
  };
}
