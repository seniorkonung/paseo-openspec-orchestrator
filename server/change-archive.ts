import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { dirname } from "node:path";
import { z } from "zod";
import type { CompleteRequiredAgentProfile } from "./agent-profiles.ts";
import { FIXED_BRANCH_RULE, NO_GITHUB_RULE, OPENSPEC_CLI_RULE, buildAgentPrompt, completionInstruction } from "./agent-prompt.ts";
import { combineAbortSignals, throwIfSignalAborted } from "./agent-session-control.ts";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { archivedChangeSchema, ChangeArchiveError, pendingArchiveSessionSchema, type ArchivedChange, type PendingArchiveSession } from "./change-archive-model.ts";
import { createChangeArchiveVerification, type ChangeArchiveVerification } from "./change-archive-verification.ts";
import { createManagedAgentSession } from "./managed-agent-session.ts";
import { McpToolError, OrchestratorMcpToolHost, defineMcpTool } from "./orchestrator-mcp-tool-host.ts";
import { updateAgentNotificationLabel, type AgentNotificationLabelUpdater } from "./paseo-agent-labels.ts";
import type { RootPullRequestIdentity, RootPullRequestService } from "./root-pull-request.ts";
import { deliverRootCommit } from "./root-branch-delivery.ts";

type PaseoApi = PluginHandlerContext["paseo"];
type PaseoWorkspace = ReturnType<PaseoApi["workspaces"]["ref"]>;
type PaseoAgent = Awaited<ReturnType<PaseoWorkspace["agents"]["create"]>>;
type AgentCreator = (options: Parameters<PaseoWorkspace["agents"]["create"]>[0]) => Promise<PaseoAgent>;

export interface ChangeArchiveService {
  plan(directory: string, changeId: string, identity: RootPullRequestIdentity, signal?: AbortSignal): Promise<PendingArchiveSession>;
  run(request: {
    readonly workspaceDirectory: string;
    readonly profile: CompleteRequiredAgentProfile;
    readonly session: PendingArchiveSession;
    readonly signal: AbortSignal;
    readonly onAgentCreated: (agentId: string) => void;
  }): Promise<ArchivedChange>;
  verifyArchived(directory: string, archived: ArchivedChange, signal?: AbortSignal): Promise<void>;
}

interface McpHostFactory { listen(): Promise<OrchestratorMcpToolHost>; }

export function createChangeArchiveService(options: {
  readonly createAgent: AgentCreator;
  readonly rootPullRequest: RootPullRequestService;
  readonly command?: BoundedCommandRunner;
  readonly verification?: ChangeArchiveVerification;
  readonly mcpHost?: McpHostFactory;
  readonly updateNotificationLabel?: AgentNotificationLabelUpdater;
  readonly agentDrainTimeoutMs?: number;
  readonly logger?: Pick<Console, "error" | "warn">;
}): ChangeArchiveService {
  const command = options.command ?? runBoundedCommand;
  const verification = options.verification ?? createChangeArchiveVerification({ rootPullRequest: options.rootPullRequest, command });
  const mcpHost = options.mcpHost ?? OrchestratorMcpToolHost;
  const logger = options.logger ?? console;
  return {
    plan: (directory, id, identity, signal) => verification.plan(directory, id, identity, signal),
    verifyArchived: (directory, archived, signal) => verification.verifyArchived(directory, archived, signal),
    async run(request) {
      throwIfSignalAborted(request.signal);
      const session = pendingArchiveSessionSchema.parse(request.session);
      const recovery = await verification.inspectRecovery(request.workspaceDirectory, session, request.signal);
      const host = await mcpHost.listen();
      let completed: ArchivedChange | null = null;
      const agentSession = createManagedAgentSession<ArchivedChange>({
        signal: request.signal,
        host,
        updateNotificationLabel: options.updateNotificationLabel ?? updateAgentNotificationLabel,
        agentDrainTimeoutMs: options.agentDrainTimeoutMs ?? 15_000,
        logContext: "архивация OpenSpec change",
        logger,
      });
      const scope = await agentSession.openScope(() => host.expose({
        complete_change_archive: defineMcpTool({
          description: "Проверить синхронизацию specs, архивный коммит и публикацию в корневом Draft PR",
          inputSchema: z.object({}).strict(),
          outputSchema: archivedChangeSchema,
          execute: (_input, toolContext) => agentSession.runExclusive(async () => {
            if (completed) return { text: "Архивация уже принята", data: completed };
            const combined = combineAbortSignals(request.signal, toolContext.signal);
            try {
              const activeAgent = await agentSession.waitForAgent(combined.signal);
              let verified: ArchivedChange;
              try {
                verified = await verification.verifyCommit(request.workspaceDirectory, session, combined.signal);
                await deliverRootCommit(request.workspaceDirectory, session.changeId, session.baselineCommit, verified.commit, combined.signal, command, session.rootPullRequest);
                const pr = await options.rootPullRequest.inspect(request.workspaceDirectory, session.changeId, session.branch, session.rootPullRequest, combined.signal);
                if (pr.kind !== "open" || !pr.isDraft || pr.head !== verified.commit) throw new ChangeArchiveError("Архивный коммит не подтверждён в Draft PR");
              } catch (error) {
                if (combined.signal.aborted) throw error;
                if (error instanceof ChangeArchiveError) throw new McpToolError(error.message);
                logger.error("[OpenSpec] Не удалось проверить архивный коммит", { changeId: session.changeId, code: errorCode(error) });
                throw new McpToolError("Не удалось проверить или опубликовать архивный коммит");
              }
              try {
                await agentSession.disableNotifications(combined.signal);
              } catch (error) {
                if (combined.signal.aborted) throw error;
                logger.error("[OpenSpec] Не удалось отключить ntfy архивного агента", { agentId: activeAgent.id, code: errorCode(error) });
                throw new McpToolError("Не удалось отключить финальное уведомление агента; повторите вызов");
              }
              completed = verified;
              agentSession.complete(verified);
              return { text: "Change архивирован и опубликован в корневом PR", data: verified };
            } finally { combined.dispose(); }
          }),
        }),
      }));
      try {
        const config = scope.configureAgent({
          provider: `${request.profile.provider}/${request.profile.model}`,
          modeId: request.profile.modeId,
          thinkingOptionId: request.profile.thinkingOptionId,
          ...(request.profile.featureValues == null ? {} : { featureValues: request.profile.featureValues }),
        });
        const agent = await agentSession.launchAgent(() => options.createAgent({
          config,
          title: `Архивация OpenSpec change: ${session.changeId}`,
          labels: { ntfy: "true" },
        }), request.onAgentCreated);
        if (recovery !== "committed") {
          const catalog = await agent.commands();
          const names = new Set(catalog.commands.map(({ name }) => name));
          if (catalog.error || !names.has("openspec-archive-change")) {
            throw new ChangeArchiveError("Агент не загрузил обязательный skill openspec-archive-change");
          }
          if (session.deltaSpecPaths.length > 0 && !names.has("openspec-sync-specs")) {
            throw new ChangeArchiveError("Агент не загрузил обязательный skill openspec-sync-specs для синхронизации");
          }
        }
        await agent.send(changeArchivePrompt(session, recovery));
        const result = await agentSession.waitForCompletion();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await agentSession.drainAgent();
        return result;
      } finally { await agentSession.close(); }
    },
  };
}

export function changeArchivePrompt(session: PendingArchiveSession, recovery: "fresh" | "partial" | "committed"): string {
  const specRoot = `${dirname(dirname(session.sourcePath))}/specs`;
  const action = recovery === "committed"
    ? "Recovery: the expected archive commit already exists. Do not invoke the skill, change files, or create another commit. Call the completion tool."
    : recovery === "partial"
      ? "Recovery: inspect the existing uncommitted archive/spec changes. If the active change still exists, resume the `openspec-archive-change` skill. If it has already moved, finish and verify spec sync using the skill's archive rules without moving it again."
      : `Invoke the installed \`openspec-archive-change\` skill for change \`${session.changeId}\`.`;
  return buildAgentPrompt({
    role: "You own the final archive stage of one completed OpenSpec change.",
    communication: "blocker-only",
    workflowData: {
      changeId: session.changeId,
      branch: session.branch,
      baselineCommit: session.baselineCommit,
      sourcePath: session.sourcePath,
      archivePath: session.archivePath,
      mainSpecsRoot: specRoot,
      recovery,
    },
    rules: [OPENSPEC_CLI_RULE, NO_GITHUB_RULE, FIXED_BRANCH_RULE, "Never spawn or archive agents or workspaces, and never invoke another workflow except the inline spec-sync workflow required by the archive skill."],
    body: [
      action,
      "The user has already chosen mandatory delta-spec synchronization. If delta specs exist, sync and verify every capability before moving the change. Never choose 'Archive without syncing' or proceed with incomplete artifacts, tasks, or a sync blocker. If already synced, archive directly. Report a genuine blocker in Russian.",
      `Use the exact archive target \`${session.archivePath}\`. Preserve every file in the change unchanged during the move. Limit changes to \`${session.sourcePath}\`, \`${session.archivePath}\`, and \`${specRoot}\`. Do not edit implementation code, push, merge, or change PR state.`,
      recovery === "committed" ? "" : "After verification, stage only the allowed paths and create exactly one Conventional Commit after the baseline with a subject shorter than 72 characters; do not amend.",
    ],
    completion: completionInstruction({ tool: "complete_change_archive", retryScope: "the archive, main specs, or its single commit" }),
  });
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : error instanceof Error ? error.name : "unknown";
}
