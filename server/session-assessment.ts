/**
 * Можно ли продолжить сохранённую pending-сессию этапа.
 *
 * - `resumable` — репозиторий удовлетворяет контракту восстановления сессии:
 *   этап ещё не начат либо его результат уже проверяется этой сессией.
 * - `stale` — факты репозитория противоречат сессии. Завершить её нельзя ни при
 *   каком продолжении, поэтому этап планируется заново от текущего репозитория.
 *
 * Оценка только читает репозиторий. Если факты прочитать не удалось, оценка
 * завершается исключением: сессия остаётся неоценённой и не сбрасывается.
 */
export type SessionAssessment =
  | { readonly kind: "resumable" }
  | { readonly kind: "stale"; readonly reason: string };

export const RESUMABLE_SESSION: SessionAssessment = Object.freeze({ kind: "resumable" });

export function staleSession(reason: string): SessionAssessment {
  return { kind: "stale", reason };
}
