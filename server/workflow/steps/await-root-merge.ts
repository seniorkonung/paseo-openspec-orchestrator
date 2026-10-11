import { setTimeout as delay } from "node:timers/promises";
import type { ChangeArchiveService } from "../../change-archive.ts";
import { ChangeArchiveError } from "../../change-archive-model.ts";
import {
  RootPullRequestError,
  type RootPullRequestCheckProgress,
  type RootPullRequestIdentity,
  type RootPullRequestService,
} from "../../root-pull-request.ts";
import type { WorkflowStepContext, WorkflowStepDefinition, WorkflowStepResult } from "../types.ts";

/** Как финальный gate ждёт завершения проверок CI корневого PR. */
export interface RootChecksWaitPolicy {
  /** Пауза между запросами к GitHub. */
  readonly pollIntervalMs: number;
  /**
   * Сколько ждать с начала ожидания, прежде чем считать, что новых проверок не
   * будет: GitHub регистрирует проверки после push или перевода в Ready с задержкой.
   */
  readonly settleMs: number;
  /** Предел ожидания за один запуск шага; «Повторить» начинает новое ожидание. */
  readonly timeoutMs: number;
  /** Сколько запросов к GitHub подряд может завершиться ошибкой. */
  readonly maxConsecutiveFailures: number;
}

export const DEFAULT_ROOT_CHECKS_WAIT: RootChecksWaitPolicy = Object.freeze({
  pollIntervalMs: 30_000,
  settleMs: 60_000,
  timeoutMs: 2 * 60 * 60_000,
  maxConsecutiveFailures: 3,
});

export interface AwaitRootMergeDependencies {
  readonly workspaceDirectory: string;
  readonly archive: Pick<ChangeArchiveService, "verifyArchived">;
  readonly rootPullRequest: RootPullRequestService;
  readonly checksWait?: RootChecksWaitPolicy;
}

type ChecksWaitOutcome =
  /** Незавершённых проверок не осталось; их исход оркестратор не оценивает. */
  | { readonly kind: "settled"; readonly checks: RootPullRequestCheckProgress }
  /** PR перестал быть открытым Ready PR с проверенным HEAD; причину называет финальная сверка. */
  | { readonly kind: "changed" }
  | { readonly kind: "timeout"; readonly pending: number }
  | { readonly kind: "paused" };

/** Ждёт интервал; пауза прерывает ожидание, отмена workflow — пробрасывается. */
async function pollDelay(milliseconds: number, context: WorkflowStepContext): Promise<"elapsed" | "paused"> {
  const interrupt = new AbortController();
  const stop = () => interrupt.abort();
  context.signal.addEventListener("abort", stop, { once: true });
  context.pauseSignal.addEventListener("abort", stop, { once: true });
  try {
    if (context.signal.aborted || context.pauseSignal.aborted) stop();
    await delay(milliseconds, undefined, { signal: interrupt.signal });
    return "elapsed";
  } catch (error) {
    if (!context.signal.aborted && context.pauseSignal.aborted) return "paused";
    throw error;
  } finally {
    context.signal.removeEventListener("abort", stop);
    context.pauseSignal.removeEventListener("abort", stop);
  }
}

async function waitForChecks(
  dependencies: AwaitRootMergeDependencies,
  policy: RootChecksWaitPolicy,
  identity: RootPullRequestIdentity,
  gateHead: string,
  context: WorkflowStepContext,
): Promise<ChecksWaitOutcome> {
  const startedAt = performance.now();
  let failures = 0;
  for (;;) {
    if (context.pauseSignal.aborted) return { kind: "paused" };
    try {
      const pr = await dependencies.rootPullRequest.inspectChecks(dependencies.workspaceDirectory, identity, context.signal);
      failures = 0;
      if (pr.kind !== "open" || pr.isDraft || pr.head !== gateHead) return { kind: "changed" };
      const elapsed = performance.now() - startedAt;
      if (pr.checks.pending === 0 && elapsed >= policy.settleMs) return { kind: "settled", checks: pr.checks };
      if (elapsed >= policy.timeoutMs) return { kind: "timeout", pending: pr.checks.pending };
    } catch (error) {
      if (context.signal.aborted) throw error;
      failures += 1;
      if (failures >= policy.maxConsecutiveFailures) throw error;
      console.warn("[OpenSpec] Не удалось прочитать проверки CI корневого PR; повторю запрос", {
        pullRequest: identity.number,
        attempt: failures,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    if ((await pollDelay(policy.pollIntervalMs, context)) === "paused") return { kind: "paused" };
  }
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  return minutes % 60 === 0 ? `${minutes / 60} ч` : `${minutes} мин`;
}

async function awaitRootMerge(dependencies: AwaitRootMergeDependencies, context: WorkflowStepContext): Promise<WorkflowStepResult> {
  const { change, changeBranch, activeBranch, archivedChange, rootPullRequest } = context.state;
  if (!change || !changeBranch || activeBranch !== changeBranch || !archivedChange || !rootPullRequest) {
    return { kind: "halt", summary: "Не сохранена архивация change", message: "Перед финальным merge нужен проверенный архивный коммит" };
  }
  const policy = dependencies.checksWait ?? DEFAULT_ROOT_CHECKS_WAIT;
  try {
    // Финальный gate относится к текущему HEAD: коммиты после архивного
    // допускаются, пока change остаётся в архиве.
    const gateHead = await dependencies.archive.verifyArchived(dependencies.workspaceDirectory, archivedChange, context.signal);
    const head = await dependencies.rootPullRequest.synchronize(dependencies.workspaceDirectory, change.id, changeBranch, context.signal);
    if (head !== gateHead) throw new ChangeArchiveError("Корневая ветка изменилась во время проверки архива");
    let pr = await dependencies.rootPullRequest.inspect(dependencies.workspaceDirectory, change.id, changeBranch, rootPullRequest, context.signal);
    if (pr.head !== gateHead) throw new ChangeArchiveError("HEAD корневого PR не совпадает с проверенным архивом");
    if (pr.kind === "closed") throw new RootPullRequestError("Корневой pull request закрыт без merge");
    if (pr.kind === "merged") return { kind: "complete", summary: `Change ${change.id} архивирован, корневой PR слит` };
    context.updateActionLinks([{ kind: "external", url: pr.identity.url, label: `Корневой PR #${pr.identity.number}` }]);
    if (pr.isDraft) {
      pr = await dependencies.rootPullRequest.makeReady(dependencies.workspaceDirectory, pr, context.signal);
      if (pr.kind === "closed" || pr.head !== gateHead) throw new RootPullRequestError("Корневой PR изменился при переводе в Ready");
      if (pr.kind === "merged") return { kind: "complete", summary: `Change ${change.id} архивирован, корневой PR слит` };
      if (pr.isDraft) throw new RootPullRequestError("Корневой pull request не перешёл в Ready");
    }
    // Уведомление о merge отправляется только тогда, когда ждать больше нечего:
    // каждый запуск шага, в том числе по «Повторить», ждёт проверки текущего HEAD.
    const checks = await waitForChecks(dependencies, policy, pr.identity, gateHead, context);
    if (checks.kind === "paused") {
      return { kind: "continue", next: "await-root-merge", summary: "Ожидание проверок CI прервано паузой" };
    }
    const number = pr.identity.number;
    if (checks.kind === "timeout") {
      const summary = `Проверки CI корневого PR #${number} не завершились за ${formatDuration(policy.timeoutMs)}`;
      return { kind: "halt", summary, message: `${summary} (незавершённых: ${checks.pending}); нажмите «Повторить», чтобы ждать дальше` };
    }
    const finalGateHead = await dependencies.archive.verifyArchived(dependencies.workspaceDirectory, archivedChange, context.signal);
    const finalHead = await dependencies.rootPullRequest.synchronize(dependencies.workspaceDirectory, change.id, changeBranch, context.signal);
    const finalPr = await dependencies.rootPullRequest.inspect(dependencies.workspaceDirectory, change.id, changeBranch, pr.identity, context.signal);
    if (finalGateHead !== gateHead || finalHead !== gateHead || finalPr.head !== gateHead) throw new ChangeArchiveError("HEAD изменился после Ready");
    if (finalPr.kind === "merged") return { kind: "complete", summary: `Change ${change.id} архивирован, корневой PR слит` };
    if (finalPr.kind === "closed") throw new RootPullRequestError("Корневой pull request закрыт без merge");
    if (finalPr.isDraft) throw new RootPullRequestError("Корневой pull request вернулся в Draft");
    if (checks.kind === "changed") throw new RootPullRequestError("Корневой PR изменился во время ожидания проверок CI");
    const summary = checks.checks.total === 0
      ? `Проверок CI нет, корневой PR #${number} ожидает merge`
      : `Проверки CI завершены (${checks.checks.total}), корневой PR #${number} ожидает merge`;
    return { kind: "halt", summary, message: `Проверьте результаты и выполните merge ${finalPr.identity.url}, затем нажмите «Повторить»` };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const summary = error instanceof ChangeArchiveError || error instanceof RootPullRequestError ? error.message : "Не удалось проверить архив и корневой PR";
    return { kind: "halt", summary, message: `${summary}; исправьте состояние и нажмите «Повторить»` };
  }
}

export function createAwaitRootMergeStep(dependencies: AwaitRootMergeDependencies): WorkflowStepDefinition {
  return { id: "await-root-merge", label: "Проверяю архив, жду проверки CI и merge корневого PR", run: (context) => awaitRootMerge(dependencies, context) };
}
