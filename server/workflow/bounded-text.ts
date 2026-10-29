import { ORCHESTRATOR_LIMITS } from "../../shared/orchestrator.ts";

function bounded(text: string, maximum: number): string {
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

/** Текст действия в истории ограничен схемой ledger. */
export function boundedSummary(text: string): string {
  return bounded(text, ORCHESTRATOR_LIMITS.actionText);
}

/** Сообщение остановки workflow ограничено схемой ledger. */
export function boundedMessage(text: string): string {
  return bounded(text, ORCHESTRATOR_LIMITS.message);
}
