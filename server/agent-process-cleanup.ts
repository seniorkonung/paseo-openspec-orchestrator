import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentCleanupError } from "./agent-cleanup-error.ts";

export interface OwnedAgentProcess {
  readonly pid: number;
  readonly uid: number;
  readonly startedAt: string;
  readonly agentId: string;
}

/** Таблица обязана повторно проверить принадлежность и идентичность перед сигналом. */
export interface AgentProcessTable {
  list(agentIds: ReadonlySet<string>): Promise<readonly OwnedAgentProcess[]>;
  signal(target: OwnedAgentProcess, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export type AgentProcessCleaner = (agentIds: readonly string[]) => Promise<void>;

export interface AgentProcessCleanupOptions {
  readonly platform?: NodeJS.Platform;
  readonly table?: AgentProcessTable;
  readonly gracefulTimeoutMs?: number;
  readonly forceTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/** На других ОС закрытие runtime остаётся ответственностью Paseo. */
export function createAgentProcessCleaner(options: AgentProcessCleanupOptions = {}): AgentProcessCleaner {
  if ((options.platform ?? process.platform) !== "linux") return async () => {};
  const table = options.table ?? createLinuxAgentProcessTable();
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5_000;
  const forceTimeoutMs = options.forceTimeoutMs ?? 2_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;

  return async (agentIds) => {
    const owners = new Set(agentIds);
    if (owners.size === 0) return;
    const failures: unknown[] = [];
    for (const [signal, timeoutMs] of [["SIGTERM", gracefulTimeoutMs], ["SIGKILL", forceTimeoutMs]] as const) {
      const signaled = new Set<string>();
      const deadline = performance.now() + timeoutMs;
      do {
        const remaining = await table.list(owners);
        if (remaining.length === 0) return;
        for (const target of remaining) {
          const identity = `${target.pid}:${target.startedAt}`;
          if (signaled.has(identity)) continue;
          try {
            await table.signal(target, signal);
            signaled.add(identity);
          } catch (error) {
            failures.push(error);
          }
        }
        const waitMs = Math.min(pollIntervalMs, deadline - performance.now());
        if (waitMs > 0) await delay(waitMs);
      } while (performance.now() < deadline);
    }
    const remaining = await table.list(owners);
    if (remaining.length > 0) {
      throw new AgentCleanupError(`Не завершились процессы агента: ${remaining.map(({ pid }) => pid).join(", ")}`, failures);
    }
  };
}

interface LinuxProcessTableOptions {
  readonly procRoot?: string;
  readonly uid?: number;
  readonly sendSignal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
}

/** Читает только /proc на машине демона, без предположений о родителе процесса. */
export function createLinuxAgentProcessTable(options: LinuxProcessTableOptions = {}): AgentProcessTable {
  const procRoot = options.procRoot ?? "/proc";
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new AgentCleanupError("Не удалось определить владельца процессов");
  const sendSignal = options.sendSignal ?? ((pid, signal) => { process.kill(pid, signal); });
  const known = new Map<number, OwnedAgentProcess>();

  async function inspect(pid: number, owners?: ReadonlySet<string>): Promise<OwnedAgentProcess | null> {
    const directory = join(procRoot, String(pid));
    let startedAt: string | null = null;
    try {
      if ((await stat(directory)).uid !== uid) return null;
      const before = await readProcessIdentity(join(directory, "stat"));
      if (!before) return null;
      startedAt = before;
      const environment = await readBoundedProcessFile(join(directory, "environ"), 2 * 1024 * 1024);
      const marker = environment.split("\0").find((entry) => entry.startsWith("PASEO_AGENT_ID="));
      if (!marker) return null;
      const after = await readProcessIdentity(join(directory, "stat"));
      if (before !== after || (await stat(directory)).uid !== uid) return null;
      return { pid, uid, startedAt: before, agentId: marker.slice("PASEO_AGENT_ID=".length) };
    } catch (error) {
      if (isGone(error)) return null;
      const previous = known.get(pid);
      if (owners && error instanceof Error && "code" in error && error.code === "EACCES") {
        if (!previous || (startedAt !== null && previous.startedAt !== startedAt)) return null;
        // Проверка другой сессии сохраняет известную принадлежность, но не выбирает этот PID для сигнала.
        if (!owners.has(previous.agentId)) return previous;
      }
      throw new AgentCleanupError(`Не удалось проверить принадлежность процесса ${pid}`, [error]);
    }
  }

  return {
    async list(agentIds) {
      const entries = await readdir(procRoot);
      const owned: OwnedAgentProcess[] = [];
      const present = new Set(entries.map(Number));
      for (const pid of known.keys()) if (!present.has(pid)) known.delete(pid);
      // Ограничиваем число одновременно открытых файлов при большом /proc.
      let next = 0;
      await Promise.all(Array.from({ length: 8 }, async () => {
        while (next < entries.length) {
          const entry = entries[next++];
          if (!entry || !/^[1-9]\d*$/.test(entry)) continue;
          const pid = Number(entry);
          if (!Number.isSafeInteger(pid) || pid === process.pid || pid === 1) continue;
          const target = await inspect(pid, agentIds);
          if (target) {
            if (agentIds.has(target.agentId)) owned.push(target);
            known.set(pid, target);
          } else {
            known.delete(pid);
          }
        }
      }));
      return owned;
    },
    async signal(target, signal) {
      if (target.pid <= 1 || target.pid === process.pid) return;
      const current = await inspect(target.pid);
      if (!current || current.uid !== target.uid || current.startedAt !== target.startedAt || current.agentId !== target.agentId) return;
      try {
        sendSignal(target.pid, signal);
      } catch (error) {
        if (!isGone(error)) throw error;
      }
    },
  };
}

async function readProcessIdentity(path: string): Promise<string | null> {
  const content = await readBoundedProcessFile(path, 16 * 1024);
  const fields = content.slice(content.lastIndexOf(")") + 1).trim().split(/\s+/);
  if (fields[0] === "Z" || fields[0] === "X") return null;
  const startedAt = fields[19];
  if (!startedAt || !/^\d+$/.test(startedAt)) throw new Error("Некорректный /proc/stat");
  return startedAt;
}

async function readBoundedProcessFile(path: string, maximumBytes: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(8192, maximumBytes + 1));
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= maximumBytes) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, maximumBytes + 1 - length), null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      length += bytesRead;
    }
    if (length > maximumBytes) throw new Error("Файл процесса превысил допустимый размер");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await file.close();
  }
}

function isGone(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");
}
