import { z } from "zod";
import { ORCHESTRATOR_LIMITS } from "../shared/orchestrator.ts";
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-command.ts";

const agentIdSchema = z.string().trim().min(1).max(ORCHESTRATOR_LIMITS.agentId);

export type AgentNotificationLabelUpdater = (
  agentId: string,
  enabled: boolean,
  signal?: AbortSignal,
) => Promise<void>;

export function createAgentNotificationLabelUpdater(
  command: BoundedCommandRunner = runBoundedCommand,
): AgentNotificationLabelUpdater {
  return async (agentId, enabled, signal) => {
    const normalizedAgentId = agentIdSchema.parse(agentId);
    await command(
      "paseo",
      [
        "agent",
        "update",
        normalizedAgentId,
        "--label",
        `ntfy=${enabled ? "true" : "false"}`,
        "--json",
      ],
      { signal },
    );
  };
}

export const updateAgentNotificationLabel = createAgentNotificationLabelUpdater();
