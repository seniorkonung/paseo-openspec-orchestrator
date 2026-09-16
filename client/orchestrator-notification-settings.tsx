import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsInput,
  SettingsSelect,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS,
  readOrchestratorNotificationSettingsRpc,
  saveOrchestratorNotificationSettingsRpc,
  testOrchestratorNotificationRpc,
  type OrchestratorNotificationSettingsValues,
} from "../shared/orchestrator-notifications";

type Feedback = { kind: "success" | "error"; message: string } | null;
type PriorityValue = "1" | "2" | "3" | "4" | "5";

const PRIORITY_OPTIONS: ReadonlyArray<{ label: string; value: PriorityValue }> = [
  { label: "Минимальный (1)", value: "1" },
  { label: "Низкий (2)", value: "2" },
  { label: "Обычный (3)", value: "3" },
  { label: "Высокий (4)", value: "4" },
  { label: "Максимальный (5)", value: "5" },
];

function parsePriority(value: PriorityValue): OrchestratorNotificationSettingsValues["priority"] {
  return Number(value) as OrchestratorNotificationSettingsValues["priority"];
}
export function OrchestratorNotificationSettingsScreen({
  theme,
  layout,
}: PluginSurfaceProps) {
  const readSettings = useRpc(readOrchestratorNotificationSettingsRpc);
  const saveSettings = useRpc(saveOrchestratorNotificationSettingsRpc);
  const testSettings = useRpc(testOrchestratorNotificationRpc);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<OrchestratorNotificationSettingsValues>({
    ...DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS,
  });
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setFeedback(null);
    try {
      const result = await readSettings({});
      setRevision(result.revision);
      setDraft(result.values);
      setGeneration((value) => value + 1);
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Не удалось загрузить настройки",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // RPC-функции привязаны к этой установке плагина на весь жизненный цикл экрана.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function change<Key extends keyof OrchestratorNotificationSettingsValues>(
    key: Key,
    value: OrchestratorNotificationSettingsValues[Key],
  ): void {
    setDraft((current) => ({ ...current, [key]: value }));
    setFeedback(null);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await saveSettings({ revision, values: draft });
      if (result.status === "invalid") {
        setFeedback({ kind: "error", message: result.error });
        return;
      }
      setRevision(result.revision);
      setDraft(result.values);
      setGeneration((value) => value + 1);
      setFeedback({
        kind: result.status === "saved" ? "success" : "error",
        message:
          result.status === "saved"
            ? "Настройки сохранены"
            : `${result.error}. Последние значения загружены.`,
      });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Не удалось сохранить настройки",
      });
    } finally {
      setBusy(false);
    }
  }

  async function sendTest(): Promise<void> {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await testSettings({ values: draft });
      setFeedback({ kind: result.ok ? "success" : "error", message: result.message });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Не удалось отправить тестовое уведомление",
      });
    } finally {
      setBusy(false);
    }
  }

  async function reset(): Promise<void> {
    setDraft({ ...DEFAULT_ORCHESTRATOR_NOTIFICATION_SETTINGS });
    setFeedback(null);
  }

  const disabled = loading || busy;
  return (
    <View
      style={{
        flex: 1,
        gap: 16,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      }}
    >
      <SettingsSection
        title="Уведомления оркестратора"
        info="Настройки независимы от paseo-ntfy. Пустая тема отключает отправку."
      >
        <SettingsSwitch
          label="Отправлять уведомления"
          hint="Отключение применяется ко всем событиям workflow."
          value={draft.enabled}
          disabled={disabled}
          onValueChange={(value) => change("enabled", value)}
        />
        <SettingsInput
          key={`server-${generation}`}
          label="Адрес ntfy"
          hint="Корень сервера, без пути темы."
          initialValue={draft.serverUrl}
          placeholder="https://ntfy.sh"
          disabled={disabled}
          onChangeText={(value) => change("serverUrl", value)}
        />
        <SettingsInput
          key={`topic-${generation}`}
          label="Тема"
          hint="Оставьте пустой, чтобы временно отключить доставку."
          initialValue={draft.topic}
          placeholder="paseo-openspec"
          disabled={disabled}
          onChangeText={(value) => change("topic", value)}
        />
        <SettingsInput
          key={`token-${generation}`}
          label="Токен доступа"
          hint="Необязательный Bearer-токен; хранится на host Paseo."
          initialValue={draft.accessToken}
          placeholder="Необязательно"
          secureTextEntry
          disabled={disabled}
          onChangeText={(value) => change("accessToken", value)}
        />
        <SettingsSelect
          label="Приоритет"
          hint="Используется для уведомлений об ошибках, завершении и прогрессе."
          value={String(draft.priority) as PriorityValue}
          options={PRIORITY_OPTIONS}
          disabled={disabled}
          onValueChange={(value) => change("priority", parsePriority(value))}
        />
      </SettingsSection>

      <SettingsSection title="Действия">
        <SettingsAction
          label="Сохранить изменения"
          actionLabel={busy ? "Выполняется…" : "Сохранить"}
          disabled={disabled}
          onPress={() => void save()}
        />
        <SettingsAction
          label="Проверить текущие значения"
          hint="Тест использует введённые значения и не требует предварительного сохранения."
          actionLabel={busy ? "Выполняется…" : "Отправить тест"}
          disabled={disabled}
          onPress={() => void sendTest()}
        />
        <SettingsAction
          label="Сбросить форму"
          actionLabel="Восстановить значения по умолчанию"
          disabled={disabled}
          onPress={() => void reset()}
        />
        {loading ? <Text style={{ color: theme.colors.foregroundMuted }}>Загружаю настройки…</Text> : null}
        {feedback ? (
          <Text
            style={{
              color:
                feedback.kind === "success"
                  ? theme.colors.statusSuccess
                  : theme.colors.statusDanger,
            }}
          >
            {feedback.message}
          </Text>
        ) : null}
        {!loading && feedback?.kind === "error" ? (
          <SettingsAction
            label="Заново загрузить значения с host"
            actionLabel="Загрузить"
            disabled={busy}
            onPress={() => void load()}
          />
        ) : null}
      </SettingsSection>
    </View>
  );
}
