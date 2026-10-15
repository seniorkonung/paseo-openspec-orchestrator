import { setTimeout as delay } from "node:timers/promises";
import { AgentCleanupError, withCleanupDeadline } from "./agent-cleanup-error.ts";

export interface AgentCleanupClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const clock: AgentCleanupClock = { now: () => performance.now(), sleep: delay };

/** Один срок для всех попыток и вложенных операций, независимо от отмены workflow. */
export class AgentCleanupBudget {
  readonly #deadline: number;
  readonly #operationTimeoutMs: number;
  readonly #clock: AgentCleanupClock;

  constructor(timeoutMs: number, operationTimeoutMs = 20_000, cleanupClock = clock) {
    this.#clock = cleanupClock;
    this.#deadline = cleanupClock.now() + timeoutMs;
    this.#operationTimeoutMs = operationTimeoutMs;
  }

  remainingMs(): number {
    return Math.max(0, this.#deadline - this.#clock.now());
  }

  timeoutMs(maximumMs = this.#operationTimeoutMs): number {
    const remaining = this.remainingMs();
    if (remaining <= 0) throw new AgentCleanupError("Истёк общий срок очистки ресурсов агента");
    return Math.min(maximumMs, remaining);
  }

  run<Value>(operation: () => Promise<Value>, maximumMs?: number): Promise<Value> {
    return withCleanupDeadline(() => {
      this.timeoutMs(maximumMs);
      return operation();
    }, Math.ceil(this.timeoutMs(maximumMs)));
  }

  async wait(ms: number): Promise<void> {
    const remaining = this.remainingMs();
    if (remaining > 0) await this.#clock.sleep(Math.min(ms, remaining));
  }
}
