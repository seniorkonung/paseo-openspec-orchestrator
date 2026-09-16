import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ORCHESTRATOR_LIMITS = {
  workspaceId: 512,
  revision: 128,
  changeId: 256,
  changeTitle: 256,
  actionId: 128,
  actionText: 500,
  agentId: 512,
  agentLabel: 120,
  agentLinks: 8,
  message: 500,
} as const;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const isoTimestamp = z.string().datetime({ offset: true });

export const workspaceIdSchema = boundedText(ORCHESTRATOR_LIMITS.workspaceId);
export const revisionSchema = boundedText(ORCHESTRATOR_LIMITS.revision);

export const agentLinkSchema = z
  .object({
    kind: z.literal("agent"),
    agentId: boundedText(ORCHESTRATOR_LIMITS.agentId),
    label: boundedText(ORCHESTRATOR_LIMITS.agentLabel),
  })
  .strict();

const agentLinksSchema = z
  .array(agentLinkSchema)
  .max(ORCHESTRATOR_LIMITS.agentLinks)
  .superRefine((links, context) => {
    const identifiers = new Set<string>();
    for (const [index, link] of links.entries()) {
      if (identifiers.has(link.agentId)) {
        context.addIssue({
          code: "custom",
          path: [index, "agentId"],
          message: "Agent-ссылка должна быть уникальной внутри действия",
        });
      }
      identifiers.add(link.agentId);
    }
  });

export const currentActionSchema = z
  .object({
    id: boundedText(ORCHESTRATOR_LIMITS.actionId),
    text: boundedText(ORCHESTRATOR_LIMITS.actionText),
    startedAt: isoTimestamp,
    links: agentLinksSchema,
  })
  .strict();

export const completedActionSchema = currentActionSchema
  .extend({
    finishedAt: isoTimestamp,
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
  })
  .superRefine((action, context) => {
    if (Date.parse(action.finishedAt) < Date.parse(action.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "Время завершения действия не может предшествовать времени начала",
      });
    }
  });

export const controlCommandSchema = z.enum(["start", "pause", "resume", "retry", "clear"]);

export const lifecycleSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle"), availableCommand: z.literal("start") }).strict(),
  z.object({ status: z.literal("starting"), availableCommand: z.null() }).strict(),
  z.object({ status: z.literal("running"), availableCommand: z.literal("pause") }).strict(),
  z.object({ status: z.literal("pausing"), availableCommand: z.null() }).strict(),
  z.object({ status: z.literal("paused"), availableCommand: z.literal("resume") }).strict(),
  z.object({ status: z.literal("completed"), availableCommand: z.literal("start") }).strict(),
  z
    .object({
      status: z.literal("failed"),
      availableCommand: z.literal("retry"),
      message: boundedText(ORCHESTRATOR_LIMITS.message),
    })
    .strict(),
]);

export const orchestratorChangeSchema = z
  .object({
    id: boundedText(ORCHESTRATOR_LIMITS.changeId),
    title: z.string().trim().max(ORCHESTRATOR_LIMITS.changeTitle).optional(),
  })
  .strict();

export const persistenceStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready") }).strict(),
  z
    .object({
      status: z.literal("degraded"),
      message: boundedText(ORCHESTRATOR_LIMITS.message),
    })
    .strict(),
]);

export const orchestratorSnapshotSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    revision: revisionSchema,
    change: orchestratorChangeSchema.nullable(),
    lifecycle: lifecycleSchema,
    currentAction: currentActionSchema.nullable(),
    history: z.array(completedActionSchema),
    persistence: persistenceStateSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.currentAction !== null &&
      !["running", "pausing"].includes(snapshot.lifecycle.status)
    ) {
      context.addIssue({
        code: "custom",
        path: ["currentAction"],
        message: "Текущее действие несовместимо с состоянием оркестратора",
      });
    }

    const identifiers = new Set<string>();
    for (const [index, action] of snapshot.history.entries()) {
      if (identifiers.has(action.id)) {
        context.addIssue({
          code: "custom",
          path: ["history", index, "id"],
          message: "Идентификатор действия должен быть уникальным",
        });
      }
      identifiers.add(action.id);

      const previous = snapshot.history[index - 1];
      if (previous && Date.parse(action.startedAt) < Date.parse(previous.startedAt)) {
        context.addIssue({
          code: "custom",
          path: ["history", index, "startedAt"],
          message: "История должна быть упорядочена от старых действий к новым",
        });
      }
    }

    if (snapshot.currentAction && identifiers.has(snapshot.currentAction.id)) {
      context.addIssue({
        code: "custom",
        path: ["currentAction", "id"],
        message: "Текущее действие не может одновременно находиться в истории",
      });
    }
  });

export type AgentLink = z.infer<typeof agentLinkSchema>;
export type CurrentAction = z.infer<typeof currentActionSchema>;
export type CompletedAction = z.infer<typeof completedActionSchema>;
export type ControlCommand = z.infer<typeof controlCommandSchema>;
export type OrchestratorLifecycle = z.infer<typeof lifecycleSchema>;
export type OrchestratorChange = z.infer<typeof orchestratorChangeSchema>;
export type PersistenceState = z.infer<typeof persistenceStateSchema>;
export type OrchestratorSnapshot = z.infer<typeof orchestratorSnapshotSchema>;

export const orchestratorGet = defineRpc({
  name: "openspec.orchestrator.get",
  input: z.object({ workspaceId: workspaceIdSchema }).strict(),
  output: orchestratorSnapshotSchema,
});

export const orchestratorWait = defineRpc({
  name: "openspec.orchestrator.wait",
  input: z
    .object({
      workspaceId: workspaceIdSchema,
      revision: revisionSchema,
    })
    .strict(),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("changed"), snapshot: orchestratorSnapshotSchema }).strict(),
    z.object({ status: z.literal("unchanged"), revision: revisionSchema }).strict(),
  ]),
});

export const orchestratorControl = defineRpc({
  name: "openspec.orchestrator.control",
  input: z
    .object({
      workspaceId: workspaceIdSchema,
      expectedRevision: revisionSchema,
      command: controlCommandSchema,
    })
    .strict(),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("accepted"), snapshot: orchestratorSnapshotSchema }).strict(),
    z
      .object({
        status: z.literal("rejected"),
        reason: z.enum(["stale", "not_allowed", "unavailable"]),
        message: boundedText(ORCHESTRATOR_LIMITS.message),
        snapshot: orchestratorSnapshotSchema,
      })
      .strict(),
  ]),
});
