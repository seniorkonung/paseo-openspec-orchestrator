import type { OrchestratorSnapshot } from "../shared/orchestrator";

export type SynchronizationStatus = "connecting" | "live" | "reconnecting";

type WaitResponse =
  | { status: "changed"; snapshot: OrchestratorSnapshot }
  | { status: "unchanged"; revision: string };

export interface SynchronizationLoopOptions {
  getCached(): OrchestratorSnapshot | undefined;
  wait(revision: string): Promise<WaitResponse>;
  resync(): Promise<OrchestratorSnapshot>;
  apply(snapshot: OrchestratorSnapshot): void;
  setStatus(status: SynchronizationStatus): void;
  sleep?: (durationMs: number) => Promise<void>;
}

export interface SynchronizationLoopHandle {
  stop(): void;
  readonly done: Promise<void>;
}

export function shouldApplyRpcSnapshot(
  cachedRevision: string | undefined,
  requestedRevision: string,
): boolean {
  return cachedRevision === requestedRevision;
}

export function selectSnapshotWithoutRegression<T extends { revision: string }>(
  revisionAtRequest: string | undefined,
  current: T | undefined,
  response: T,
): T {
  if (
    revisionAtRequest !== undefined &&
    current !== undefined &&
    current.revision !== revisionAtRequest
  ) {
    return current;
  }
  return response;
}

export function reconnectDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt), 8_000);
}

export function startSynchronizationLoop(
  options: SynchronizationLoopOptions,
): SynchronizationLoopHandle {
  let stopped = false;
  let retryAttempt = 0;
  let delayTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseDelay: (() => void) | null = null;

  const defaultSleep = (durationMs: number) =>
    new Promise<void>((resolveDelay) => {
      releaseDelay = resolveDelay;
      delayTimer = setTimeout(() => {
        delayTimer = null;
        releaseDelay = null;
        resolveDelay();
      }, durationMs);
    });
  const sleep = options.sleep ?? defaultSleep;

  const done = (async () => {
    options.setStatus("live");
    while (!stopped) {
      const beforeWait = options.getCached();
      if (!beforeWait) return;

      try {
        const response = await options.wait(beforeWait.revision);
        if (stopped) return;
        const current = options.getCached();
        if (
          response.status === "changed" &&
          shouldApplyRpcSnapshot(current?.revision, beforeWait.revision)
        ) {
          options.apply(response.snapshot);
        }
        retryAttempt = 0;
        options.setStatus("live");
      } catch {
        if (stopped) return;
        options.setStatus("reconnecting");
        await sleep(reconnectDelayMs(retryAttempt));
        retryAttempt += 1;
        if (stopped) return;

        const beforeResync = options.getCached();
        try {
          const fresh = await options.resync();
          if (stopped) return;
          const current = options.getCached();
          if (
            !beforeResync ||
            shouldApplyRpcSnapshot(current?.revision, beforeResync.revision)
          ) {
            options.apply(fresh);
          }
          retryAttempt = 0;
          options.setStatus("live");
        } catch {
          // Следующая итерация повторит reconnect с увеличенным backoff.
        }
      }
    }
  })();

  return {
    done,
    stop() {
      stopped = true;
      if (delayTimer) clearTimeout(delayTimer);
      releaseDelay?.();
    },
  };
}
