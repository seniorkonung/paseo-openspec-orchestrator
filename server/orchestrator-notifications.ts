import {
  normalizeOrchestratorWorkspaceDisplay,
  orchestratorNotificationRequestSchema,
  type OrchestratorNotificationRequest,
  type OrchestratorNotificationSettingsValues,
  type OrchestratorWorkspaceDisplay,
} from "../shared/orchestrator-notifications.ts";
import {
  OrchestratorNotificationSettingsStore,
  normalizeOrchestratorNotificationSettings,
} from "./orchestrator-notification-settings.ts";
import { publishOrchestratorNotification } from "./orchestrator-notification-publisher.ts";

export type OrchestratorNotificationPublisher = (
  settings: OrchestratorNotificationSettingsValues,
  notification: OrchestratorNotificationRequest,
  options?: { workspace?: OrchestratorWorkspaceDisplay | null },
) => Promise<void>;

export interface OrchestratorNotificationSink {
  notify(
    workspaceId: string,
    notification: OrchestratorNotificationRequest,
    workspace?: OrchestratorWorkspaceDisplay | null,
  ): Promise<boolean>;
}

export interface OrchestratorNotificationServiceOptions {
  settings?: OrchestratorNotificationSettingsStore;
  publish?: OrchestratorNotificationPublisher;
}

export class OrchestratorNotificationService implements OrchestratorNotificationSink {
  readonly #settings: OrchestratorNotificationSettingsStore;
  readonly #publish: OrchestratorNotificationPublisher;

  constructor(options: OrchestratorNotificationServiceOptions = {}) {
    this.#settings = options.settings ?? new OrchestratorNotificationSettingsStore();
    this.#publish = options.publish ?? publishOrchestratorNotification;
  }

  async notify(
    _workspaceId: string,
    notification: OrchestratorNotificationRequest,
    workspace?: OrchestratorWorkspaceDisplay | null,
  ): Promise<boolean> {
    // The workspace id is the internal notification target; user-facing context is
    // supplied separately so opaque Paseo identifiers never leak into ntfy.
    const validated = orchestratorNotificationRequestSchema.parse(notification);
    const settings = await this.#settings.read();
    if (!settings.values.enabled || !settings.values.topic) return false;
    await this.#publish(settings.values, validated, {
      workspace: normalizeOrchestratorWorkspaceDisplay(workspace),
    });
    return true;
  }

  async test(values: OrchestratorNotificationSettingsValues): Promise<void> {
    const normalized = normalizeOrchestratorNotificationSettings(values);
    if (!normalized.enabled) throw new Error("Уведомления отключены в настройках.");
    if (!normalized.topic) throw new Error("Укажите тему ntfy перед отправкой теста.");
    await this.#publish(
      normalized,
      {
        kind: "manual",
        message: "Тестовое уведомление OpenSpec-оркестратора доставлено",
      },
      { workspace: null },
    );
  }
}

export class NoopOrchestratorNotificationSink implements OrchestratorNotificationSink {
  async notify(): Promise<boolean> {
    return false;
  }
}
