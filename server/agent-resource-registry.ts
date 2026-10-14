import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { workspaceIdSchema } from "../shared/orchestrator.ts";
import { createSerializedExecutor } from "./agent-session-control.ts";
import { AgentCleanupError } from "./agent-cleanup-error.ts";
import { resolvePaseoHome } from "./paseo-home.ts";

const resourceIdentitySchema = z.object({
  agentId: z.string().min(1).max(512),
  rootAgentId: z.string().min(1).max(512),
  workspaceId: workspaceIdSchema,
}).strict();
export type AgentResourceIdentity = z.infer<typeof resourceIdentitySchema>;
export type AgentReleaseMode = "preserve" | "archive";
const resourceSchema = resourceIdentitySchema.extend({
  release: z.enum(["managed", "preserve", "archive"]),
});
const legacyRegistrySchema = z.object({
  version: z.literal(1),
  resources: z.array(resourceIdentitySchema).max(10_000),
}).strict();
const registrySchema = z.object({
  version: z.literal(2),
  resources: z.array(resourceSchema).max(10_000),
}).strict().superRefine(({ resources }, context) => {
  const byId = new Map(resources.map((resource) => [resource.agentId, resource]));
  if (byId.size !== resources.length) context.addIssue({ code: "custom", message: "Повторяющийся ID агента" });
  for (const resource of resources) {
    const root = byId.get(resource.rootAgentId);
    if (!root || root.agentId !== root.rootAgentId || root.workspaceId !== resource.workspaceId || root.release !== resource.release) {
      context.addIssue({ code: "custom", message: "Некорректный владелец ресурсов агента" });
    }
  }
});
export type AgentResource = z.infer<typeof resourceSchema>;

/** Реестр переживает сброс workflow: запись удаляется только после очистки. */
export class AgentResourceRegistry {
  readonly #path: string;
  readonly #exclusive = createSerializedExecutor();
  #resources: AgentResource[] | null = null;

  constructor(paseoHome = resolvePaseoHome()) {
    this.#path = join(paseoHome, "plugin-data", "paseo-openspec-orchestrator", "agent-resources.json");
  }

  list(): Promise<readonly AgentResource[]> {
    return this.#exclusive(async () => [...await this.#load()]);
  }

  add(...added: readonly AgentResourceIdentity[]): Promise<void> {
    return this.#exclusive(async () => {
      const resources = [...await this.#load()];
      let changed = false;
      for (const resource of added) {
        const existing = resources.find(({ agentId }) => agentId === resource.agentId);
        if (existing) {
          if (existing.rootAgentId !== resource.rootAgentId || existing.workspaceId !== resource.workspaceId) {
            throw new AgentCleanupError("Изменилась принадлежность ресурсов агента");
          }
        } else {
          const root = resources.find(({ agentId }) => agentId === resource.rootAgentId);
          resources.push({ ...resource, release: root?.release ?? "managed" });
          changed = true;
        }
      }
      if (changed) await this.#save(resources);
    });
  }

  /** Первый сохранённый режим неизменен, в том числе после перезапуска. */
  beginRelease(rootAgentId: string, requested: AgentReleaseMode): Promise<AgentReleaseMode | null> {
    return this.#exclusive(async () => {
      const resources = await this.#load();
      const root = resources.find((resource) => resource.agentId === rootAgentId && resource.rootAgentId === rootAgentId);
      if (!root) return null;
      if (root.release !== "managed") return root.release;
      await this.#save(resources.map((resource) => resource.rootAgentId === rootAgentId
        ? { ...resource, release: requested }
        : resource));
      return requested;
    });
  }

  /** Поздний ребёнок должен пройти очистку до удаления всего дерева. */
  removeRoot(rootAgentId: string, cleanedAgentIds: readonly string[]): Promise<boolean> {
    return this.#exclusive(async () => {
      const resources = await this.#load();
      const owned = resources.filter((resource) => resource.rootAgentId === rootAgentId);
      const cleaned = new Set(cleanedAgentIds);
      if (owned.length !== cleaned.size || owned.some((resource) => !cleaned.has(resource.agentId))) return false;
      await this.#save(resources.filter((resource) => resource.rootAgentId !== rootAgentId));
      return true;
    });
  }

  async #load(): Promise<AgentResource[]> {
    if (this.#resources) return this.#resources;
    try {
      const file = await open(this.#path, "r");
      try {
        if ((await file.stat()).size > 8 * 1024 * 1024) throw new Error("Реестр слишком велик");
        const input: unknown = JSON.parse(await file.readFile("utf8"));
        const legacy = legacyRegistrySchema.safeParse(input);
        if (legacy.success) {
          const migrated = registrySchema.parse({ version: 2,
            resources: legacy.data.resources.map((resource) => ({ ...resource, release: "managed" })),
          });
          await this.#save(migrated.resources);
        } else {
          this.#resources = registrySchema.parse(input).resources;
        }
      } finally { await file.close(); }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") this.#resources = [];
      else throw new AgentCleanupError("Не удалось прочитать реестр ресурсов агентов; проверьте файл agent-resources.json", [error]);
    }
    return this.#resources!;
  }

  async #save(resources: AgentResource[]): Promise<void> {
    const serialized = `${JSON.stringify(registrySchema.parse({ version: 2, resources }))}\n`;
    const directory = dirname(this.#path);
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(serialized, "utf8");
        await file.sync();
      } finally { await file.close(); }
      await rename(temporaryPath, this.#path);
      const directoryHandle = await open(directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      this.#resources = resources;
    } catch (error) {
      throw new AgentCleanupError("Не удалось сохранить реестр ресурсов агентов; проверьте доступность диска", [error]);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
