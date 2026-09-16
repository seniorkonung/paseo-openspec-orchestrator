import {
  orchestratorNotificationRequestSchema,
  type OrchestratorNotificationRequest,
  type OrchestratorNotificationSettingsValues,
} from "../shared/orchestrator-notifications.ts";
import { ORCHESTRATOR_LIMITS } from "../shared/orchestrator.ts";
import {
  OrchestratorNotificationSettingsStore,
  normalizeOrchestratorNotificationSettings,
} from "./orchestrator-notification-settings.ts";
import { publishOrchestratorNotification } from "./orchestrator-notification-publisher.ts";

export type OrchestratorNotificationPublisher = (
  settings: OrchestratorNotificationSettingsValues,
  notification: OrchestratorNotificationRequest,
) => Promise<void>;

export interface OrchestratorNotificationSink {
  notify(workspaceId: string, notification: OrchestratorNotificationRequest): Promise<boolean>;
}

export interface OrchestratorNotificationServiceOptions {
  settings?: OrchestratorNotificationSettingsStore;
  publish?: OrchestratorNotificationPublisher;
}

function withWorkspaceContext(
  workspaceId: string,
  message: string,
): string {
  return `[${workspaceId}] ${message}`.slice(0, ORCHESTRATOR_LIMITS.notificationMessage);
}

export class OrchestratorNotificationService implements OrchestratorNotificationSink {
  readonly #settings: OrchestratorNotificationSettingsStore;
  readonly #publish: OrchestratorNotificationPublisher;

  constructor(options: OrchestratorNotificationServiceOptions = {}) {
    this.#settings = options.settings ?? new OrchestratorNotificationSettingsStore();
    this.#publish = options.publish ?? publishOrchestratorNotification;
  }

  async notify(
    workspaceId: string,
    notification: OrchestratorNotificationRequest,
  ): Promise<boolean> {
    const validated = orchestratorNotificationRequestSchema.parse(notification);
    const settings = await this.#settings.read();
    if (!settings.values.enabled || !settings.values.topic) return false;
    await this.#publish(settings.values, {
      ...validated,
      message: withWorkspaceContext(workspaceId, validated.message),
    });
    return true;
  }

  async test(values: OrchestratorNotificationSettingsValues): Promise<void> {
    const normalized = normalizeOrchestratorNotificationSettings(values);
    if (!normalized.enabled) throw new Error("Уведомления отключены в настройках.");
    if (!normalized.topic) throw new Error("Укажите тему ntfy перед отправкой теста.");
    await this.#publish(normalized, {
      kind: "manual",
      message: "Тестовое уведомление OpenSpec-оркестратора доставлено",
    });
  }
}

export class NoopOrchestratorNotificationSink implements OrchestratorNotificationSink {
  async notify(): Promise<boolean> {
    return false;
  }
}
