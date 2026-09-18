import type { AgentNotificationLabelUpdater } from "./paseo-agent-labels.ts";
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
}

export interface ManagedAgentSessionOptions {
  readonly signal: AbortSignal;
  readonly host: AsyncClosable;
  readonly updateNotificationLabel: AgentNotificationLabelUpdater;
  readonly agentDrainTimeoutMs: number;
  readonly logContext: string;
  readonly logger: Pick<Console, "warn">;
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
 * сериализацию их вызовов, отмену ожидания, best-effort cleanup и точное
 * отслеживание состояния финального уведомления.
 */
export function createManagedAgentSession<Result>(
  options: ManagedAgentSessionOptions,
): ManagedAgentSession<Result> {
  const agentReady = createDeferred<ManagedAgent>();
  const completion = createDeferred<Result>();
  void completion.promise.catch(() => undefined);

  let agent: ManagedAgent | null = null;
  let scope: AsyncClosable | null = null;
  let notificationsEnabled = false;
  let closed = false;
  const runExclusive = createSerializedExecutor();
  const abortCompletion = () => completion.reject(abortError());
  options.signal.addEventListener("abort", abortCompletion, { once: true });

  const warn = (
    operation: "drain-agent" | "disable-notifications" | "close-scope" | "close-host",
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

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener("abort", abortCompletion);

    if (agent && notificationsEnabled) {
      try {
        await options.updateNotificationLabel(agent.id, false);
        notificationsEnabled = false;
      } catch (error) {
        warn("disable-notifications", error);
      }
    }
    if (scope) {
      try {
        await scope.close();
      } catch (error) {
        warn("close-scope", error);
      }
    }
    try {
      await options.host.close();
    } catch (error) {
      warn("close-host", error);
    }
  };

  return {
    runExclusive,

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
      if (agent) throw new Error("Agent-сессия уже запустила агента");
      const createdAgent = await create();
      agent = createdAgent;
      notificationsEnabled = true;
      throwIfSignalAborted(options.signal);
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
        await agent.waitForFinish(options.agentDrainTimeoutMs);
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
