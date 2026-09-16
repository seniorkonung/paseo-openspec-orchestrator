import {
  orchestratorNotificationKindLabels,
  type OrchestratorNotificationRequest,
  type OrchestratorNotificationSettingsValues,
} from "../shared/orchestrator-notifications.ts";

export interface OrchestratorNotificationFetchResponse {
  ok: boolean;
  status: number;
}
export type OrchestratorNotificationFetch = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<OrchestratorNotificationFetchResponse>;

export interface PublishOrchestratorNotificationOptions {
  fetch?: OrchestratorNotificationFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function publishOrchestratorNotification(
  settings: OrchestratorNotificationSettingsValues,
  notification: OrchestratorNotificationRequest,
  options: PublishOrchestratorNotificationOptions = {},
): Promise<void> {
  if (!settings.enabled || !settings.topic) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.accessToken) {
    headers.Authorization = `Bearer ${settings.accessToken}`;
  }
  const body = {
    topic: settings.topic,
    title: orchestratorNotificationKindLabels[notification.kind],
    message: notification.message,
    priority: settings.priority,
  };
  const fetchNtfy = options.fetch ?? (fetch as unknown as OrchestratorNotificationFetch);

  try {
    const response = await fetchNtfy(settings.serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Ntfy вернул HTTP ${response.status}.`);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
