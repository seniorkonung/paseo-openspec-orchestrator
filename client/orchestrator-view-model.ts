import type {
  CompletedAction,
  ControlCommand,
  OrchestratorChange,
  OrchestratorLifecycle,
  OrchestratorSnapshot,
} from "../shared/orchestrator";

export const lifecycleLabels: Record<OrchestratorLifecycle["status"], string> = {
  idle: "Готов к запуску",
  starting: "Запускается",
  running: "Выполняется",
  pausing: "Останавливается на безопасной точке",
  paused: "Приостановлен",
  completed: "Завершён",
  failed: "Ошибка",
};

export const commandLabels: Record<ControlCommand, string> = {
  start: "Запустить",
  pause: "Пауза",
  resume: "Продолжить",
  retry: "Повторить",
};

export const outcomeSigns: Record<CompletedAction["outcome"], string> = {
  succeeded: "✓",
  failed: "×",
  cancelled: "–",
};

export function formatDuration(startedAt: string, finishedAt: string): string {
  const milliseconds = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
  if (milliseconds < 1_000) return "< 1 с";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes} мин` : `${minutes} мин ${remainingSeconds} с`;
}

export function getTimelineUpdate(
  previousLength: number,
  nextLength: number,
  atBottom: boolean,
): { added: number; shouldScroll: boolean } {
  const added = Math.max(0, nextLength - previousLength);
  return {
    added,
    shouldScroll: previousLength > 0 && added > 0 && atBottom,
  };
}

export function formatChangeLabel(change: OrchestratorChange | null | undefined): string {
  if (change === undefined) return "Загружается…";
  if (change === null) return "Change не выбран";
  return change.title ? `${change.title} · ${change.id}` : change.id;
}

export function currentStateDescription(snapshot: OrchestratorSnapshot | undefined): string {
  if (!snapshot) return "Ожидаю состояние сервера";
  if (snapshot.lifecycle.status === "failed") return snapshot.lifecycle.message;
  if (snapshot.lifecycle.status === "paused") {
    return "Новые действия не начнутся до продолжения";
  }
  if (snapshot.lifecycle.status === "completed") {
    return "Все действия текущего запуска завершены";
  }
  if (snapshot.lifecycle.status === "idle") return "Оркестратор ещё не запущен";
  if (snapshot.lifecycle.status === "starting") {
    return "Подготавливаю демонстрационный запуск";
  }
  if (snapshot.lifecycle.status === "pausing") {
    return "Текущее действие завершится перед паузой";
  }
  return "Готовлю следующее действие";
}
