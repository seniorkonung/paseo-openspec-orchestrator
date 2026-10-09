import type { AgentNotificationLabelUpdater } from "./paseo-agent-labels.ts";
import { AgentCleanupError, withCleanupDeadline } from "./agent-cleanup-error.ts";
import {
  abortError,
  createDeferred,
  createSerializedExecutor,
  throwIfSignalAborted,
  waitForPromise,
  type SerializedExecutor,
} from "./agent-session-control.ts";

interface AsyncClosable {
  close(): Promise<void>;
}

interface ManagedAgent {
  readonly id: string;
  waitForFinish(timeoutMs: number): Promise<unknown>;
  archive(): Promise<unknown>;
}

export type AgentResourceReleaser = (
  agent: Pick<ManagedAgent, "id" | "archive">,
  closeLocalResources: () => Promise<void>,
) => Promise<void>;

export interface ManagedAgentSessionOptions {
  readonly signal: AbortSignal;
  readonly host: AsyncClosable;
  readonly updateNotificationLabel: AgentNotificationLabelUpdater;
  readonly agentDrainTimeoutMs: number;
  readonly logContext: string;
  readonly logger: Pick<Console, "warn">;
  readonly cleanupTimeoutMs?: number;
  readonly releaseAgent?: AgentResourceReleaser;
}

export interface ManagedAgentSession<Result> {
  readonly runExclusive: SerializedExecutor;
  openScope<Scope extends AsyncClosable>(create: () => Scope): Promise<Scope>;
  launchAgent<Agent extends ManagedAgent>(
    create: () => Promise<Agent>,
    onCreated: (agentId: string) => void,
  ): Promise<Agent>;
  waitForAgent(signal: AbortSignal): Promise<ManagedAgent>;
  disableNotifications(signal?: AbortSignal): Promise<void>;
  restoreNotifications(signal?: AbortSignal): Promise<void>;
  complete(result: Result): void;
  waitForCompletion(): Promise<Result>;
  drainAgent(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Владеет общим runtime-состоянием одного агента и его MCP scope.
 *
 * Доменный сценарий по-прежнему решает, что проверять и когда считать работу
 * завершённой. Сессия гарантирует порядок публикации агента MCP-инструментам,
 * сериализацию их вызовов, отмену ожидания, закрытие агента и точное
 * отслеживание состояния финального уведомления.
 */
export function createManagedAgentSession<Result>(
  options: ManagedAgentSessionOptions,
): ManagedAgentSession<Result> {
  const agentReady = createDeferred<ManagedAgent>();
  void agentReady.promise.catch(() => undefined);
  const completion = createDeferred<Result>();
  void completion.promise.catch(() => undefined);

  let agent: ManagedAgent | null = null;
  let scope: AsyncClosable | null = null;
  let notificationsEnabled = false;
  let closed = false;
  let creation: Promise<ManagedAgent> | null = null;
  let creationWaitExpired = false;
  let closePromise: Promise<void> | null = null;
  let agentClosePromise: Promise<void> | null = null;
  let localClosePromise: Promise<void> | null = null;
  const closedLocalResources = new Set<AsyncClosable>();
  const runExclusive = createSerializedExecutor();
  const abortCompletion = () => {
    completion.reject(abortError());
    agentReady.reject(abortError());
  };
  options.signal.addEventListener("abort", abortCompletion, { once: true });
  if (options.signal.aborted) abortCompletion();

  const warn = (
    operation: "drain-agent" | "disable-notifications" | "archive-agent" | "create-agent" | "close-scope" | "close-host",
    error: unknown,
  ): void => {
    try {
      options.logger.warn(
        `[OpenSpec] Ошибка управляемой agent-сессии (${options.logContext})`,
        {
          operation,
          ...(agent == null ? {} : { agentId: agent.id }),
          code: errorCode(error),
        },
      );
    } catch {
      // Ошибка диагностического logger не должна прерывать cleanup ресурсов.
    }
  };

  const closeLocalResources = (): Promise<void> => {
    if (localClosePromise) return localClosePromise;
    const closing = (async () => {
      const failures: unknown[] = [];
      for (const [operation, resource] of [["close-scope", scope], ["close-host", options.host]] as const) {
        if (!resource || closedLocalResources.has(resource)) continue;
        try {
          await withCleanupDeadline(() => resource.close(), options.cleanupTimeoutMs);
          closedLocalResources.add(resource);
        } catch (error) {
          failures.push(error);
          warn(operation, error);
        }
      }
      if (failures.length) throw new AgentCleanupError("Не удалось закрыть MCP scope или host", failures);
    })();
    localClosePromise = closing;
    void closing.catch(() => {
      if (localClosePromise === closing) localClosePromise = null;
    });
    return closing;
  };

  const closeAgent = (): Promise<void> => {
    if (agentClosePromise) return agentClosePromise;
    const ownedAgent = agent;
    if (!ownedAgent) return Promise.resolve();
    agentClosePromise = (async () => {
      if (notificationsEnabled) {
        try {
          await withCleanupDeadline(() => options.updateNotificationLabel(ownedAgent.id, false), options.cleanupTimeoutMs);
          notificationsEnabled = false;
        } catch (error) {
          warn("disable-notifications", error);
        }
      }
      await withCleanupDeadline(
        () => options.releaseAgent ? options.releaseAgent(ownedAgent, closeLocalResources) : ownedAgent.archive(),
        options.cleanupTimeoutMs,
      );
    })();
    return agentClosePromise;
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    options.signal.removeEventListener("abort", abortCompletion);
    agentReady.reject(abortError());
    completion.reject(abortError());
    closePromise = (async () => {
      const failures: unknown[] = [];
      if (creation) {
        try {
          await withCleanupDeadline(() => creation!, options.cleanupTimeoutMs);
        } catch (error) {
          if (error instanceof AgentCleanupError) {
            creationWaitExpired = true;
            failures.push(error);
            warn("create-agent", error);
          }
          // Отклонённое создание уже сообщило ошибку вызывающему сценарию.
        }
      }
      try {
        await closeAgent();
      } catch (error) {
        failures.push(error);
        warn("archive-agent", error);
      }
      try { await closeLocalResources(); }
      catch (error) { failures.push(error); }
      if (failures.length > 0) {
        throw new AgentCleanupError("Не удалось освободить ресурсы агента; нажмите «Повторить» для повторной очистки", failures);
      }
    })();
    return closePromise;
  };

  return {
    runExclusive: (operation) => runExclusive(() => {
      if (closed) throw abortError();
      return operation();
    }),

    async openScope(create) {
      if (closed) throw new Error("Agent-сессия уже закрыта");
      if (scope) throw new Error("MCP scope уже принадлежит agent-сессии");
      try {
        const ownedScope = create();
        scope = ownedScope;
        return ownedScope;
      } catch (error) {
        await close();
        throw error;
      }
    },

    async launchAgent(create, onCreated) {
      if (closed) throw new Error("Agent-сессия уже закрыта");
      throwIfSignalAborted(options.signal);
      if (creation) throw new Error("Agent-сессия уже запустила агента");
      const creating = create().then((createdAgent) => {
        agent = createdAgent;
        notificationsEnabled = true;
        if (creationWaitExpired) {
          void closeAgent().catch((error) => warn("archive-agent", error));
        }
        return createdAgent;
      });
      creation = creating;
      const createdAgent = await waitForPromise(creating, options.signal);
      throwIfSignalAborted(options.signal);
      if (closed) throw abortError();
      onCreated(createdAgent.id);
      agentReady.resolve(createdAgent);
      return createdAgent;
    },

    waitForAgent(signal) {
      return waitForPromise(agentReady.promise, signal);
    },

    async disableNotifications(signal) {
      if (!agent) throw new Error("Агент ещё не запущен");
      await options.updateNotificationLabel(agent.id, false, signal);
      notificationsEnabled = false;
    },

    async restoreNotifications(signal) {
      if (!agent) throw new Error("Агент ещё не запущен");
      await options.updateNotificationLabel(agent.id, true, signal);
      notificationsEnabled = true;
    },

    complete(result) {
      completion.resolve(result);
    },

    waitForCompletion() {
      return completion.promise;
    },

    async drainAgent() {
      if (!agent) return;
      try {
        await waitForPromise(agent.waitForFinish(options.agentDrainTimeoutMs), options.signal);
      } catch (error) {
        warn("drain-agent", error);
      }
    },

    close,
  };
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String(error.code);
  }
  if (error instanceof Error) return error.name;
  return "UNKNOWN";
}
