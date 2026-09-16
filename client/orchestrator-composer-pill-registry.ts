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

export class OrchestratorComposerPillRegistry {
  private readonly agents = new Map<string, string>();
  private readonly availability = new Map<string, boolean>();
  private readonly pills = new Map<string, ComposerPillRegistration>();
  private readonly createPill: ComposerPillFactory;

  constructor(createPill: ComposerPillFactory) {
    this.createPill = createPill;
  }

  upsertAgent(target: AgentComposerTarget): string | null {
    const agentId = target.agentId.trim();
    const workspaceId = target.workspaceId?.trim() || null;
    if (!agentId || !workspaceId || target.archived) {
      this.removeAgent(agentId);
      return null;
    }

    const previousWorkspaceId = this.agents.get(agentId);
    if (previousWorkspaceId === workspaceId) return null;

    this.removePill(agentId);
    this.agents.set(agentId, workspaceId);
    this.reconcileAgent(agentId, workspaceId);
    if (previousWorkspaceId) this.removeUnusedAvailability(previousWorkspaceId);
    return workspaceId;
  }

  removeAgent(agentId: string): void {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) return;
    const workspaceId = this.agents.get(normalizedAgentId);
    this.removePill(normalizedAgentId);
    this.agents.delete(normalizedAgentId);
    if (workspaceId) this.removeUnusedAvailability(workspaceId);
  }

  setWorkspaceAvailability(workspaceId: string, installed: boolean): void {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId || !this.hasAgentsInWorkspace(normalizedWorkspaceId)) return;
    this.availability.set(normalizedWorkspaceId, installed);
    for (const [agentId, agentWorkspaceId] of this.agents) {
      if (agentWorkspaceId === normalizedWorkspaceId) {
        this.reconcileAgent(agentId, normalizedWorkspaceId);
      }
    }
  }

  clear(): void {
    for (const registration of this.pills.values()) registration.remove();
    this.pills.clear();
    this.agents.clear();
    this.availability.clear();
  }

  private reconcileAgent(agentId: string, workspaceId: string): void {
    if (this.availability.get(workspaceId) !== true) {
      this.removePill(agentId);
      return;
    }
    if (this.pills.has(agentId)) return;
    this.pills.set(agentId, this.createPill({ agentId, workspaceId }));
  }

  private removePill(agentId: string): void {
    this.pills.get(agentId)?.remove();
    this.pills.delete(agentId);
  }

  private removeUnusedAvailability(workspaceId: string): void {
    if (!this.hasAgentsInWorkspace(workspaceId)) this.availability.delete(workspaceId);
  }

  private hasAgentsInWorkspace(workspaceId: string): boolean {
    for (const agentWorkspaceId of this.agents.values()) {
      if (agentWorkspaceId === workspaceId) return true;
    }
    return false;
  }
}
