export interface AgentComposerTarget {
  agentId: string;
  workspaceId: string | null;
  archived: boolean;
}

export interface ComposerPillRegistration {
  remove(): void;
}

export type ComposerPillFactory = (target: {
  agentId: string;
  workspaceId: string;
}) => ComposerPillRegistration;

export interface OrchestratorComposerPillRegistry {
  upsertAgent(target: AgentComposerTarget): string | null;
  removeAgent(agentId: string): void;
  setWorkspaceAvailability(workspaceId: string, installed: boolean): void;
  clear(): void;
}

export function createOrchestratorComposerPillRegistry(
  createPill: ComposerPillFactory,
): OrchestratorComposerPillRegistry {
  const agents = new Map<string, string>();
  const availability = new Map<string, boolean>();
  const pills = new Map<string, ComposerPillRegistration>();

  function upsertAgent(target: AgentComposerTarget): string | null {
    const agentId = target.agentId.trim();
    const workspaceId = target.workspaceId?.trim() || null;
    if (!agentId || !workspaceId || target.archived) {
      removeAgent(agentId);
      return null;
    }

    const previousWorkspaceId = agents.get(agentId);
    if (previousWorkspaceId === workspaceId) return null;

    removePill(agentId);
    agents.set(agentId, workspaceId);
    reconcileAgent(agentId, workspaceId);
    if (previousWorkspaceId) removeUnusedAvailability(previousWorkspaceId);
    return workspaceId;
  }

  function removeAgent(agentId: string): void {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) return;
    const workspaceId = agents.get(normalizedAgentId);
    removePill(normalizedAgentId);
    agents.delete(normalizedAgentId);
    if (workspaceId) removeUnusedAvailability(workspaceId);
  }

  function setWorkspaceAvailability(workspaceId: string, installed: boolean): void {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId || !hasAgentsInWorkspace(normalizedWorkspaceId)) return;
    availability.set(normalizedWorkspaceId, installed);
    for (const [agentId, agentWorkspaceId] of agents) {
      if (agentWorkspaceId === normalizedWorkspaceId) {
        reconcileAgent(agentId, normalizedWorkspaceId);
      }
    }
  }

  function clear(): void {
    for (const registration of pills.values()) registration.remove();
    pills.clear();
    agents.clear();
    availability.clear();
  }

  function reconcileAgent(agentId: string, workspaceId: string): void {
    if (availability.get(workspaceId) !== true) {
      removePill(agentId);
      return;
    }
    if (pills.has(agentId)) return;
    pills.set(agentId, createPill({ agentId, workspaceId }));
  }

  function removePill(agentId: string): void {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  }

  function removeUnusedAvailability(workspaceId: string): void {
    if (!hasAgentsInWorkspace(workspaceId)) availability.delete(workspaceId);
  }

  function hasAgentsInWorkspace(workspaceId: string): boolean {
    for (const agentWorkspaceId of agents.values()) {
      if (agentWorkspaceId === workspaceId) return true;
    }
    return false;
  }

  return { clear, removeAgent, setWorkspaceAvailability, upsertAgent };
}
