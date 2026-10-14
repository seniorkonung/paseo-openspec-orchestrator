import { randomUUID } from "node:crypto";
import type { PluginHandlerContext, PluginHookAgent } from "@getpaseo/plugin/server";
import { AgentCleanupError, withCleanupDeadline } from "./agent-cleanup-error.ts";
import { AgentResourceRegistry, type AgentResourceIdentity, type AgentReleaseMode } from "./agent-resource-registry.ts";
import { createAgentProcessCleaner, type AgentProcessCleaner } from "./agent-process-cleanup.ts";
import { createSerializedExecutor } from "./agent-session-control.ts";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import { markPaseoAgentPreserved, PRESERVED_AGENT_LABEL, stopPaseoAgent } from "./paseo-agent-lifecycle.ts";

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
  readonly command?: BoundedCommandRunner;
}

/** Владеет агентами, созданными через демон; не зависит от дерева процесса плагина. */
export class AgentResources {
  readonly #registry: AgentResourceRegistry;
  readonly #cleanProcesses: AgentProcessCleaner;
  readonly #cleanupTimeoutMs: number;
  readonly #command: BoundedCommandRunner;
  readonly #ownership = createSerializedExecutor();
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
    this.#command = options.command ?? runBoundedCommand;
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
          autoArchive: false,
          labels: { ...options.labels, [OWNER_LABEL]: OWNER, [ROOT_LABEL]: agentId },
        });
        if (agent.id !== agentId) throw new AgentCleanupError("Демон вернул другой ID созданного агента");
        if (this.#stopping) {
          await this.release(agentId, paseo, "preserve");
          throw new AgentCleanupError("Оркестратор остановлен во время создания агента");
        }
        return agent;
      } catch (error) {
        this.#activeRoots.delete(agentId);
        try { await this.release(agentId, paseo, "preserve"); }
        catch (cleanupError) { throw new AgentCleanupError("Не удалось очистить ресурсы после ошибки создания агента", [error, cleanupError]); }
        throw error;
      }
    } finally {
      this.#creatingWorkspaces.delete(workspace.id);
    }
  }

  release(agentId: string, paseo: PaseoApi, mode: AgentReleaseMode, closeLocalResources?: () => Promise<void>): Promise<void> {
    if (closeLocalResources) this.#localClosers.set(agentId, closeLocalResources);
    const existing = this.#releases.get(agentId);
    if (existing) return existing;
    this.#activeRoots.delete(agentId);
    const releasing = this.#releaseRoot(agentId, paseo, mode).catch(async (error: unknown) => {
      // Ошибка чтения или записи реестра тоже не должна оставлять MCP открытым.
      try { await this.#closeLocalResources(agentId); }
      catch (closeError) { throw new AgentCleanupError("Не удалось освободить агента и закрыть MCP", [error, closeError]); }
      throw error;
    });
    this.#releases.set(agentId, releasing);
    void releasing.finally(() => {
      if (this.#releases.get(agentId) === releasing) this.#releases.delete(agentId);
    }).catch(() => undefined);
    return releasing;
  }

  async #closeLocalResources(rootAgentId: string): Promise<void> {
    await this.#localClosers.get(rootAgentId)?.();
    this.#localClosers.delete(rootAgentId);
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
    const root = await this.#ownership(async () => {
      let owner = await this.#findRoot(agent.id, paseo);
      if (!owner && agent.parentAgentId) owner = await this.#findRoot(agent.parentAgentId, paseo);
      if (!owner) owner = await this.#findRoot(agent.id, paseo);
      if (!owner) return;
      await this.#registry.add(
        { agentId: owner.rootAgentId, rootAgentId: owner.rootAgentId, workspaceId: owner.workspaceId },
        { agentId: agent.id, rootAgentId: owner.rootAgentId, workspaceId: owner.workspaceId },
      );
      return owner;
    });
    if (!root) return;
    // Hook не ожидает архивацию: иначе RPC демона может ждать собственный hook.
    if (!this.#activeRoots.has(root.rootAgentId)) {
      const rootAgentId = root.rootAgentId;
      const pending = this.#releases.get(rootAgentId);
      void (async () => {
        // Добавление могло попасть после последнего удаления записей в текущем проходе.
        if (pending) await pending.catch(() => undefined);
        if (!this.#activeRoots.has(rootAgentId)) await this.release(rootAgentId, paseo, "preserve");
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
      try { await this.release(root.agentId, paseo, root.release === "managed" ? "preserve" : root.release); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AgentCleanupError("Не удалось освободить ресурсы предыдущих агентов; нажмите «Повторить»", failures);
  }

  async #releaseRoot(rootAgentId: string, paseo: PaseoApi, requested: AgentReleaseMode): Promise<void> {
    const failures: unknown[] = [];
    const registeredRoot = (await this.#registry.list()).find((record) => record.agentId === rootAgentId);
    let rootSnapshot: Awaited<ReturnType<Agent["refresh"]>> | undefined;
    try {
      rootSnapshot = await withCleanupDeadline(() => paseo.agents.ref(rootAgentId).refresh(), this.#cleanupTimeoutMs);
    } catch (error) {
      // Запись preserve могла остаться после успешной передачи управления.
      // Без чтения метки нельзя отличить старые процессы от ручного продолжения.
      if (registeredRoot?.release === "preserve") {
        throw new AgentCleanupError("Не удалось проверить передачу управления сохранённой сессией; нажмите «Повторить»", [error]);
      }
      failures.push(error);
    }
    if (rootSnapshot?.agent.labels?.[PRESERVED_AGENT_LABEL] === "true") {
      // Метка — завершённая передача управления. Сбой удаления реестра
      // после неё разрешает лишь повторное удаление, но не остановку агента.
      await this.#closeLocalResources(rootAgentId);
      await this.#ownership(async () => {
        const owned = (await this.#registry.list()).filter((record) => record.rootAgentId === rootAgentId);
        if (!await this.#registry.removeRoot(rootAgentId, owned.map((record) => record.agentId))) {
          throw new AgentCleanupError("Не удалось удалить записи сохранённой сессии; нажмите «Повторить»");
        }
      });
      return;
    }
    // Дочерние агенты могли появиться до доставки lifecycle hook.
    try { await this.#discover(paseo); } catch (error) { failures.push(error); }
    const root = (await this.#registry.list()).find((record) => record.agentId === rootAgentId);
    // Старые записи не содержат исход этапа. Уже архивированный корень
    // требует прежней очистки, остальные сессии сохраняются.
    if (root?.release === "managed" && requested === "preserve") {
      if (rootSnapshot?.agent.archivedAt) requested = "archive";
    }
    const mode = await this.#registry.beginRelease(rootAgentId, requested);
    const released = new Set<string>();
    for (let pass = 0; pass < 32; pass++) {
      const records = (await this.#registry.list()).filter((record) => record.rootAgentId === rootAgentId);
      if (records.length === 0) {
        await this.#closeLocalResources(rootAgentId);
        return;
      }
      for (const record of records) {
        if (released.has(record.agentId)) continue;
        try {
          const agent = paseo.agents.ref(record.agentId);
          if (mode === "archive") {
            await withCleanupDeadline(async () => {
              if (await agent.refresh()) await agent.archive();
            }, this.#cleanupTimeoutMs);
          } else {
            await stopPaseoAgent(agent, this.#command, this.#cleanupTimeoutMs);
          }
          released.add(record.agentId);
        } catch (error) { failures.push(error); }
      }
      // Даже при ошибке SDK освобождаем процессы и локальные ресурсы.
      try { await this.#cleanProcesses(records.map((record) => record.agentId)); }
      catch (error) { failures.push(error); }
      try { await this.#closeLocalResources(rootAgentId); }
      catch (error) { failures.push(error); }
      if (failures.length) throw new AgentCleanupError("Не удалось остановить или архивировать агента, завершить его процессы или закрыть MCP; нажмите «Повторить»", failures);
      const removed = await this.#ownership(async () => {
        // Проверяем и потомков, чей hook ещё не доставлен. Передача управления
        // и обнаружение сериализованы, чтобы старый снимок не вернул владельца.
        await this.#discoverOwned(paseo);
        const owned = (await this.#registry.list()).filter((record) => record.rootAgentId === rootAgentId);
        if (owned.some((record) => !released.has(record.agentId))) return false;
        if (mode === "preserve") {
          const snapshot = await withCleanupDeadline(() => paseo.agents.ref(rootAgentId).refresh(), this.#cleanupTimeoutMs);
          if (snapshot && !snapshot.agent.archivedAt) {
            await markPaseoAgentPreserved(rootAgentId, this.#command, this.#cleanupTimeoutMs);
          }
        }
        return this.#registry.removeRoot(rootAgentId, records.map((record) => record.agentId));
      });
      if (removed) {
        this.#localClosers.delete(rootAgentId);
        return;
      }
    }
    throw new AgentCleanupError("Во время очистки продолжают появляться дочерние агенты; нажмите «Повторить»");
  }

  async #findRoot(agentId: string, paseo: PaseoApi): Promise<AgentResourceIdentity | undefined> {
    const visited = new Set<string>();
    let current: string | null = agentId;
    while (current && visited.size < 32 && !visited.has(current)) {
      visited.add(current);
      const existing = (await this.#registry.list()).find((record) => record.agentId === current);
      if (existing) {
        const root = await withCleanupDeadline(() => paseo.agents.ref(existing.rootAgentId).refresh(), this.#cleanupTimeoutMs);
        return root?.agent.labels?.[PRESERVED_AGENT_LABEL] === "true" ? undefined : existing;
      }
      const ancestorId = current;
      const snapshot: Awaited<ReturnType<Agent["refresh"]>> = await withCleanupDeadline(() => paseo.agents.ref(ancestorId).refresh(), this.#cleanupTimeoutMs);
      if (!snapshot) return;
      const agent: AgentSnapshot = snapshot.agent;
      if (agent.labels?.[PRESERVED_AGENT_LABEL] === "true") return;
      if (agent.labels?.[OWNER_LABEL] === OWNER && agent.labels[ROOT_LABEL] === agent.id && agent.workspaceId) {
        const root = { agentId: agent.id, rootAgentId: agent.id, workspaceId: agent.workspaceId };
        return root;
      }
      current = agent.labels?.[PARENT_LABEL] ?? null;
    }
  }

  #discover(paseo: PaseoApi): Promise<void> {
    return this.#ownership(() => this.#discoverOwned(paseo));
  }

  async #discoverOwned(paseo: PaseoApi): Promise<void> {
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
    const records = new Map<string, AgentResourceIdentity>((await this.#registry.list()).map((record) => [record.agentId, record]));
    const preservedRoots = new Set(candidates.filter(({ agent }) => agent.labels?.[PRESERVED_AGENT_LABEL] === "true").map(({ agent }) => agent.id));
    for (const [id, record] of records) {
      if (preservedRoots.has(record.rootAgentId)) records.delete(id);
    }
    for (const { agent } of candidates) {
      if (agent.labels?.[OWNER_LABEL] !== OWNER || agent.labels[ROOT_LABEL] !== agent.id || !agent.workspaceId) continue;
      if (preservedRoots.has(agent.id)) continue;
      const root = { agentId: agent.id, rootAgentId: agent.id, workspaceId: agent.workspaceId };
      await this.#registry.add(root);
      records.set(agent.id, root);
    }
    const parents = new Map<string, AgentResourceIdentity | undefined>();
    for (const { agent } of candidates) {
      const parentAgentId = agent.labels?.[PARENT_LABEL];
      if (records.has(agent.id) || !parentAgentId || preservedRoots.has(agent.id)) continue;
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
