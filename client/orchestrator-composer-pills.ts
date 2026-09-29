import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createOrchestratorComposerPillRegistry } from "./orchestrator-composer-pill-registry";
import { openSpecAvailability } from "../shared/openspec-availability";

const AGENT_PAGE_SIZE = 200;

type AgentListResult = Awaited<ReturnType<PluginClientContext["paseo"]["agents"]["list"]>>;
type AgentSnapshot = AgentListResult["entries"][number]["agent"];
type AgentSubscription = NonNullable<AgentListResult["subscription"]>;
type AgentUpdateHandler = Parameters<PluginClientContext["paseo"]["agents"]["subscribe"]>[0];
type AgentUpdate = Parameters<AgentUpdateHandler>[0];

export function registerOrchestratorComposerPills(client: PluginClientContext): () => void {
  let stopped = false;
  let loadingInitialSnapshot = true;
  let agentSubscription: AgentSubscription | null = null;
  const bufferedUpdates: AgentUpdate[] = [];
  const availabilityRequests = new Map<string, Promise<void>>();
  const registry = createOrchestratorComposerPillRegistry(({ agentId, workspaceId }) =>
    client.addComposerPill({
      id: "open-orchestrator",
      workspaceId,
      agentId,
      button: {
        title: "Открыть оркестратор OpenSpec",
        icon: "Workflow",
        label: "ORCH",
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel("orchestrator", { workspaceId });
          },
        },
      },
    }),
  );

  function upsertAgent(agent: AgentSnapshot): void {
    const workspaceId = registry.upsertAgent({
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      archived: Boolean(agent.archivedAt),
    });
    if (workspaceId) void refreshWorkspaceAvailability(workspaceId);
  }

  function applyAgentUpdate(update: AgentUpdate): void {
    if (update.kind === "upsert") {
      upsertAgent(update.agent);
      return;
    }
    registry.removeAgent(update.agentId);
  }

  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (loadingInitialSnapshot) {
      bufferedUpdates.push(update);
      return;
    }
    applyAgentUpdate(update);
  });

  async function refreshWorkspaceAvailability(workspaceId: string): Promise<void> {
    if (stopped) return;
    const existingRequest = availabilityRequests.get(workspaceId);
    if (existingRequest) return existingRequest;

    const request = client
      .rpc(openSpecAvailability, { workspaceId })
      .then(({ installed }) => {
        if (!stopped) registry.setWorkspaceAvailability(workspaceId, installed);
      })
      .catch((error: unknown) => {
        console.warn("[OpenSpec] Не удалось обновить доступность оркестратора", {
          workspaceId,
          error,
        });
      })
      .finally(() => {
        availabilityRequests.delete(workspaceId);
      });
    availabilityRequests.set(workspaceId, request);
    return request;
  }

  function adoptAgentSubscription(subscription: AgentSubscription): void {
    if (stopped) {
      releaseAgentSubscription(subscription);
      return;
    }
    agentSubscription = subscription;
    // После переподключения хост заново запрашивает подписку и присылает свежий снимок:
    // агенты, созданные за время обрыва связи, получают шильдик без перезапуска клиента.
    subscription.subscribe({
      snapshot(snapshot) {
        for (const { agent } of snapshot.entries) upsertAgent(agent);
      },
      update() {},
    });
  }

  function releaseAgentSubscription(subscription: AgentSubscription): void {
    subscription.release().catch((error: unknown) => {
      console.warn("[OpenSpec] Не удалось освободить подписку на агентов", error);
    });
  }

  async function loadInitialAgents(): Promise<void> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    try {
      do {
        // Идентификатор подписки назначает хост: Paseo 0.10+ отклоняет
        // запрос с явным subscriptionId, а 0.8 генерирует его сам.
        const page = await client.paseo.agents.list({
          scope: "active",
          page: cursor ? { limit: AGENT_PAGE_SIZE, cursor } : { limit: AGENT_PAGE_SIZE },
          ...(cursor ? {} : { subscribe: {} }),
        });
        if (page.subscription) adoptAgentSubscription(page.subscription);
        if (stopped) return;
        for (const { agent } of page.entries) upsertAgent(agent);

        const nextCursor = page.pageInfo.nextCursor ?? undefined;
        if (!nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);
    } catch (error) {
      console.warn("[OpenSpec] Не удалось загрузить список агентов", error);
    } finally {
      if (!stopped) {
        loadingInitialSnapshot = false;
        for (const update of bufferedUpdates.splice(0)) applyAgentUpdate(update);
      }
    }
  }

  void loadInitialAgents();

  return () => {
    stopped = true;
    unsubscribeAgents();
    if (agentSubscription) releaseAgentSubscription(agentSubscription);
    agentSubscription = null;
    bufferedUpdates.length = 0;
    registry.clear();
  };
}
