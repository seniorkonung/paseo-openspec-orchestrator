import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ORCHESTRATOR_LIMITS } from "./orchestrator.ts";

const boundedNotificationText = (maximum: number) =>
  z.string().trim().min(1).max(maximum);

export const ORCHESTRATOR_NOTIFICATION_KINDS = [
  "retry",
  "completed",
  "manual",
  "progress",
] as const;

export const orchestratorNotificationKindSchema = z.enum(
  ORCHESTRATOR_NOTIFICATION_KINDS,
);

export type OrchestratorNotificationKind = z.infer<
  typeof orchestratorNotificationKindSchema
>;

export const orchestratorNotificationRequestSchema = z
  .object({
    kind: orchestratorNotificationKindSchema,
    message: boundedNotificationText(ORCHESTRATOR_LIMITS.notificationMessage),
  })
  .strict();

export type OrchestratorNotificationRequest = z.infer<
  typeof orchestratorNotificationRequestSchema
>;

export const orchestratorNotificationSettingsValuesSchema = z
  .object({
    enabled: z.boolean(),
    serverUrl: z.string().trim().max(2_048),
    topic: z.string().trim().max(64),
    accessToken: z.string().max(512),
    priority: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]),
  })
  .strict();

export type OrchestratorNotificationSettingsValues = z.infer<
  typeof orchestratorNotificationSettingsValuesSchema
>;

export const DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS: OrchestratorNotificationSettingsValues = {
  enabled: true,
  serverUrl: "https://ntfy.sh",
  topic: "",
  accessToken: "",
  priority: 3,
};

const settingsSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    values: orchestratorNotificationSettingsValuesSchema,
  })
  .strict();

export const readOrchestratorNotificationSettingsRpc = defineRpc({
  name: "openspec.orchestrator.notifications.settings.read",
  input: z.object({}).strict(),
  output: settingsSnapshotSchema,
});

export const saveOrchestratorNotificationSettingsRpc = defineRpc({
  name: "openspec.orchestrator.notifications.settings.save",
  input: z
    .object({
      revision: z.number().int().nonnegative(),
      values: orchestratorNotificationSettingsValuesSchema,
    })
    .strict(),
  output: z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("saved"),
        revision: z.number().int().positive(),
        values: orchestratorNotificationSettingsValuesSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("conflict"),
        revision: z.number().int().nonnegative(),
        values: orchestratorNotificationSettingsValuesSchema,
        error: z.string(),
      })
      .strict(),
    z
      .object({
        status: z.literal("invalid"),
        revision: z.number().int().nonnegative(),
        error: z.string(),
      })
      .strict(),
  ]),
});

export const testOrchestratorNotificationRpc = defineRpc({
  name: "openspec.orchestrator.notifications.test",
  input: z
    .object({
      values: orchestratorNotificationSettingsValuesSchema,
    })
    .strict(),
  output: z
    .discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), message: z.string() }).strict(),
      z.object({ ok: z.literal(false), message: z.string() }).strict(),
    ])
    .describe("Результат тестовой отправки уведомления"),
});

export const orchestratorNotificationKindLabels: Record<
  OrchestratorNotificationKind,
  string
> = {
  retry: "Требуется повтор",
  completed: "Workflow завершён",
  manual: "Уведомление оркестратора",
  progress: "Workflow в работе",
};
