import { randomUUID } from "node:crypto";
import type { PluginHandlerContext, PluginHookAgent } from "@getpaseo/plugin/server";
import { AgentCleanupError, withCleanupDeadline } from "./agent-cleanup-error.ts";
import { AgentResourceRegistry, type AgentResource } from "./agent-resource-registry.ts";
import { createAgentProcessCleaner, type AgentProcessCleaner } from "./agent-process-cleanup.ts";

type PaseoApi = PluginHandlerContext["paseo"];
type Workspace = ReturnType<PaseoApi["workspaces"]["ref"]>;
type AgentOptions = Parameters<Workspace["agents"]["create"]>[0];
type Agent = Awaited<ReturnType<Workspace["agents"]["create"]>>;
type AgentSnapshot = NonNullable<Awaited<ReturnType<Agent["refresh"]>>>["agent"];

const OWNER_LABEL = "openspec-orchestrator";
const ROOT_LABEL = "openspec-root-agent-id";
const PARENT_LABEL = "parent-agent-id";
const OWNER = "paseo-openspec-orchestrator";

export interface AgentResourcesOptions {
  readonly registry?: AgentResourceRegistry;
  readonly cleanProcesses?: AgentProcessCleaner;
  readonly cleanupTimeoutMs?: number;
}

/** Владеет агентами, созданными через демон; не зависит от дерева процесса плагина. */
export class AgentResources {
  readonly #registry: AgentResourceRegistry;
  readonly #cleanProcesses: AgentProcessCleaner;
  readonly #cleanupTimeoutMs: number;
  readonly #activeRoots = new Set<string>();
  readonly #creatingWorkspaces = new Set<string>();
  readonly #releases = new Map<string, Promise<void>>();
  readonly #localClosers = new Map<string, () => Promise<void>>();
  #initialization: Promise<void> | null = null;
  #paseo: PaseoApi | null = null;
  #stopping = false;

  constructor(options: AgentResourcesOptions = {}) {
    this.#registry = options.registry ?? new AgentResourceRegistry();
    this.#cleanProcesses = options.cleanProcesses ?? createAgentProcessCleaner();
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? 20_000;
  }

  /** SDK предоставляет доступ к демону только в контексте RPC или lifecycle hook. */
  initialize(paseo: PaseoApi): Promise<void> {
    this.#paseo = paseo;
    if (this.#initialization) return this.#initialization;
    const initializing = (async () => {
      let discoveryError: unknown;
      try { await this.#discover(paseo); } catch (error) { discoveryError = error; }
      // Даже недоступный демон не мешает очистить процессы из сохранённого реестра.
      await this.#recover(paseo);
      if (discoveryError) throw discoveryError;
    })();
    this.#initialization = initializing;
    void initializing.catch(() => {
      if (this.#initialization === initializing) this.#initialization = null;
    });
    return initializing;
  }

  async create(workspace: Workspace, paseo: PaseoApi, options: AgentOptions): Promise<Agent> {
    if (this.#creatingWorkspaces.has(workspace.id)) throw new AgentCleanupError("В рабочей области уже создаётся агент");
    this.#creatingWorkspaces.add(workspace.id);
    try {
      await this.recover(paseo, workspace.id);
      if (this.#stopping) throw new AgentCleanupError("Оркестратор останавливается");
      const agentId = randomUUID();
      await this.#registry.add({ agentId, rootAgentId: agentId, workspaceId: workspace.id });
      this.#activeRoots.add(agentId);
      try {
        const agent = await workspace.agents.create({
          ...options,
          agentId,
          labels: { ...options.labels, [OWNER_LABEL]: OWNER, [ROOT_LABEL]: agentId },
        });
        if (agent.id !== agentId) throw new AgentCleanupError("Демон вернул другой ID созданного агента");
        if (this.#stopping) {
          await this.release(agentId, paseo);
          throw new AgentCleanupError("Оркестратор остановлен во время создания агента");
        }
        return agent;
      } catch (error) {
        this.#activeRoots.delete(agentId);
        try { await this.release(agentId, paseo); }
        catch (cleanupError) { throw new AgentCleanupError("Не удалось очистить ресурсы после ошибки создания агента", [error, cleanupError]); }
        throw error;
      }
    } finally {
      this.#creatingWorkspaces.delete(workspace.id);
    }
  }

  release(agentId: string, paseo: PaseoApi, closeLocalResources?: () => Promise<void>): Promise<void> {
    if (closeLocalResources) this.#localClosers.set(agentId, closeLocalResources);
    const existing = this.#releases.get(agentId);
    if (existing) return existing;
    this.#activeRoots.delete(agentId);
    const releasing = this.#releaseRoot(agentId, paseo);
    this.#releases.set(agentId, releasing);
    void releasing.finally(() => {
      if (this.#releases.get(agentId) === releasing) this.#releases.delete(agentId);
    }).catch(() => undefined);
    return releasing;
  }

  async recover(paseo: PaseoApi, workspaceId?: string): Promise<void> {
    await this.initialize(paseo);
    await this.#recover(paseo, workspaceId);
  }

  async runStage<Value>(workspaceId: string, paseo: PaseoApi, operation: () => Promise<Value>): Promise<Value> {
    await this.recover(paseo, workspaceId);
    try { return await operation(); }
    finally { await this.assertReleased(workspaceId); }
  }

  async assertReleased(workspaceId: string): Promise<void> {
    if ((await this.#registry.list()).some((resource) => resource.workspaceId === workspaceId)) {
      throw new AgentCleanupError("Ресурсы предыдущего агента не освобождены; нажмите «Повторить» для повторной очистки");
    }
  }

  async onAgentCreated(agent: PluginHookAgent, paseo: PaseoApi): Promise<void> {
    this.#paseo = paseo;
    const records = await this.#registry.list();
    let root = records.find((record) => record.agentId === agent.id);
    if (!root && agent.parentAgentId) root = await this.#findRoot(agent.parentAgentId, paseo);
    if (!root) root = await this.#findRoot(agent.id, paseo);
    if (!root) return;
    await this.#registry.add(
      { agentId: root.rootAgentId, rootAgentId: root.rootAgentId, workspaceId: root.workspaceId },
      { agentId: agent.id, rootAgentId: root.rootAgentId, workspaceId: root.workspaceId },
    );
    // Hook не ожидает архивацию: иначе RPC демона может ждать собственный hook.
    if (!this.#activeRoots.has(root.rootAgentId)) {
      const rootAgentId = root.rootAgentId;
      const pending = this.#releases.get(rootAgentId);
      void (async () => {
        // Добавление могло попасть после последнего удаления записей в текущем проходе.
        if (pending) await pending.catch(() => undefined);
        if (!this.#activeRoots.has(rootAgentId)) await this.release(rootAgentId, paseo);
      })().catch((error: unknown) => {
        console.warn("[OpenSpec] Отложенная очистка агента не завершена", { agentId: agent.id, code: error instanceof AgentCleanupError ? error.code : "UNKNOWN" });
      });
    }
  }

  async close(): Promise<void> {
    this.stop();
    this.#activeRoots.clear();
    if (this.#paseo) await this.#recover(this.#paseo);
  }

  stop(): void {
    this.#stopping = true;
  }

  async #recover(paseo: PaseoApi, workspaceId?: string): Promise<void> {
    const roots = (await this.#registry.list()).filter((record) => record.agentId === record.rootAgentId && (!workspaceId || record.workspaceId === workspaceId));
    const failures: unknown[] = [];
    for (const root of roots) {
      if (this.#activeRoots.has(root.agentId)) {
        if (workspaceId) failures.push(new AgentCleanupError("Предыдущая сессия агента ещё активна"));
        continue;
      }
      try { await this.release(root.agentId, paseo); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AgentCleanupError("Не удалось освободить ресурсы предыдущих агентов; нажмите «Повторить»", failures);
  }

  async #releaseRoot(rootAgentId: string, paseo: PaseoApi): Promise<void> {
    const failures: unknown[] = [];
    // Дочерние агенты могли появиться до доставки lifecycle hook.
    try { await this.#discover(paseo); } catch (error) { failures.push(error); }
    const archived = new Set<string>();
    for (let pass = 0; pass < 32; pass++) {
      const records = (await this.#registry.list()).filter((record) => record.rootAgentId === rootAgentId);
      if (records.length === 0) {
        await this.#localClosers.get(rootAgentId)?.();
        this.#localClosers.delete(rootAgentId);
        return;
      }
      for (const record of records) {
        if (archived.has(record.agentId)) continue;
        try {
          await withCleanupDeadline(async () => {
            const agent = paseo.agents.ref(record.agentId);
            if (await agent.refresh()) await agent.archive();
          }, this.#cleanupTimeoutMs);
          archived.add(record.agentId);
        } catch (error) { failures.push(error); }
      }
      // Архивация могла частично завершиться: процессы очищаются даже при её ошибке.
      try { await this.#cleanProcesses(records.map((record) => record.agentId)); }
      catch (error) { failures.push(error); }
      try { await this.#localClosers.get(rootAgentId)?.(); }
      catch (error) { failures.push(error); }
      if (failures.length) throw new AgentCleanupError("Не удалось архивировать агента, завершить его процессы или закрыть MCP; нажмите «Повторить»", failures);
      if (await this.#registry.removeRoot(rootAgentId, records.map((record) => record.agentId))) {
        this.#localClosers.delete(rootAgentId);
        return;
      }
    }
    throw new AgentCleanupError("Во время очистки продолжают появляться дочерние агенты; нажмите «Повторить»");
  }

  async #findRoot(agentId: string, paseo: PaseoApi): Promise<AgentResource | undefined> {
    const visited = new Set<string>();
    let current: string | null = agentId;
    while (current && visited.size < 32 && !visited.has(current)) {
      visited.add(current);
      const existing = (await this.#registry.list()).find((record) => record.agentId === current);
      if (existing) return existing;
      const ancestorId = current;
      const snapshot: Awaited<ReturnType<Agent["refresh"]>> = await withCleanupDeadline(() => paseo.agents.ref(ancestorId).refresh(), this.#cleanupTimeoutMs);
      if (!snapshot) return;
      const agent: AgentSnapshot = snapshot.agent;
      if (agent.labels?.[OWNER_LABEL] === OWNER && agent.labels[ROOT_LABEL] === agent.id && agent.workspaceId) {
        const root = { agentId: agent.id, rootAgentId: agent.id, workspaceId: agent.workspaceId };
        return root;
      }
      current = agent.labels?.[PARENT_LABEL] ?? null;
    }
  }

  async #discover(paseo: PaseoApi): Promise<void> {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const candidates: Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"] = [];
    do {
      const page = await withCleanupDeadline(() => paseo.agents.list({ scope: "active", page: { limit: 200, ...(cursor ? { cursor } : {}) } }), this.#cleanupTimeoutMs);
      candidates.push(...page.entries);
      if (candidates.length > 10_000) throw new AgentCleanupError("Слишком много агентов для проверки принадлежности ресурсов");
      cursor = page.pageInfo.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor)) throw new AgentCleanupError("Демон повторил страницу списка агентов");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const records = new Map((await this.#registry.list()).map((record) => [record.agentId, record]));
    for (const { agent } of candidates) {
      if (agent.labels?.[OWNER_LABEL] !== OWNER || agent.labels[ROOT_LABEL] !== agent.id || !agent.workspaceId) continue;
      const root = { agentId: agent.id, rootAgentId: agent.id, workspaceId: agent.workspaceId };
      await this.#registry.add(root);
      records.set(agent.id, root);
    }
    const parents = new Map<string, AgentResource | undefined>();
    for (const { agent } of candidates) {
      const parentAgentId = agent.labels?.[PARENT_LABEL];
      if (records.has(agent.id) || !parentAgentId) continue;
      let parent = records.get(parentAgentId);
      if (!parent) {
        if (!parents.has(parentAgentId)) parents.set(parentAgentId, await this.#findRoot(parentAgentId, paseo));
        parent = parents.get(parentAgentId);
      }
      if (!parent) continue;
      const root = { agentId: parent.rootAgentId, rootAgentId: parent.rootAgentId, workspaceId: parent.workspaceId };
      const child = { agentId: agent.id, rootAgentId: parent.rootAgentId, workspaceId: parent.workspaceId };
      await this.#registry.add(root, child);
      records.set(root.agentId, root);
      records.set(agent.id, child);
    }
  }
}
