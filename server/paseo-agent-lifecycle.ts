import { setTimeout as delay } from "node:timers/promises";
import { AgentCleanupError } from "./agent-cleanup-error.ts";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { resolvePaseoHome } from "./paseo-home.ts";
import { throwIfSignalAborted, waitForPromise } from "./agent-session-control.ts";

export const PRESERVED_AGENT_LABEL = "openspec-preserved";

export interface StoppableAgent {
  readonly id: string;
  refresh(): Promise<{ readonly agent: { readonly status: string; readonly archivedAt?: string | null } } | null>;
}

/** CLI stop может вернуть код 0 при ошибке cancel; подтверждаем состояние через SDK. */
export async function stopPaseoAgent(
  agent: StoppableAgent,
  command: BoundedCommandRunner = runBoundedCommand,
  timeoutMs = 20_000,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const { signal } = controller;
  try {
    const snapshot = await waitForPromise(agent.refresh(), signal);
    if (!snapshot || snapshot.agent.archivedAt || snapshot.agent.status !== "running") return;
    throwIfSignalAborted(signal);
    await waitForPromise(command("paseo", ["agent", "stop", "--json", "--home", resolvePaseoHome(), "--", agent.id], { timeoutMs, signal }), signal);
    while (true) {
      const current = await waitForPromise(agent.refresh(), signal);
      if (!current || current.agent.archivedAt || current.agent.status !== "running") return;
      await delay(100, undefined, { signal });
    }
  } catch (error) {
    throw new AgentCleanupError(`Агент ${agent.id} не подтвердил остановку`, [error]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Метка сохраняется в демоне до удаления записи из реестра очистки. */
export async function markPaseoAgentPreserved(
  agentId: string,
  command: BoundedCommandRunner = runBoundedCommand,
  timeoutMs = 20_000,
): Promise<void> {
  await command("paseo", ["agent", "update", "--label", `${PRESERVED_AGENT_LABEL}=true`, "--json", "--home", resolvePaseoHome(), "--", agentId], { timeoutMs });
}
