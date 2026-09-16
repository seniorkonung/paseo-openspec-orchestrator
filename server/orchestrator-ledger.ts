import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  chmod,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { z } from "zod";
import {
  lifecycleSchema,
  orchestratorChangeSchema,
  orchestratorSnapshotSchema,
  type CurrentAction,
  type CompletedAction,
  type OrchestratorChange,
  type OrchestratorLifecycle,
  type OrchestratorSnapshot,
  workspaceIdSchema,
} from "../shared/orchestrator.ts";
import {
  workflowCheckpointSchema,
  type WorkflowCheckpoint,
} from "./workflow/types.ts";

const LEDGER_VERSION = 1;
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
export const ORCHESTRATOR_WAIT_MS = 20_000;
export const MAX_WORKSPACE_WAITERS = 32;
export const MAX_TOTAL_WAITERS = 256;

const persistedLedgerSchema = z
  .object({
    version: z.literal(LEDGER_VERSION),
    workspaceId: workspaceIdSchema,
    revision: z.number().int().nonnegative().safe(),
    change: orchestratorChangeSchema.nullable(),
    lifecycle: lifecycleSchema,
    currentAction: orchestratorSnapshotSchema.shape.currentAction,
    history: orchestratorSnapshotSchema.shape.history,
    checkpoint: workflowCheckpointSchema.nullable().default(null),
  })
  .strict();

type PersistedLedger = z.infer<typeof persistedLedgerSchema>;
type LedgerWriter = (path: string, value: PersistedLedger) => Promise<void>;
type LedgerReader = (path: string) => Promise<string>;

export interface OrchestratorProjection {
  change: OrchestratorChange | null;
  lifecycle: OrchestratorLifecycle;
  currentAction: CurrentAction | null;
  history: CompletedAction[];
}

interface Waiter {
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: WaitResult) => void;
  settled: boolean;
}

interface WorkspaceLedger {
  workspaceId: string;
  revision: number;
  projection: OrchestratorProjection;
  checkpoint: WorkflowCheckpoint | null;
  checkpointDirty: boolean;
  clearDirty: boolean;
  persistence: OrchestratorSnapshot["persistence"];
  writesBlocked: boolean;
  readRecoveryPending: boolean;
  waiters: Set<Waiter>;
  writeQueue: Promise<void>;
  writeRequested: boolean;
  writeScheduled: boolean;
}

export type WaitResult =
  | { status: "changed"; snapshot: OrchestratorSnapshot }
  | { status: "unchanged"; revision: string };

export interface OrchestratorLedgerOptions {
  paseoHome?: string;
  waitDurationMs?: number;
  maximumWaiters?: number;
  maximumTotalWaiters?: number;
  writer?: LedgerWriter;
  reader?: LedgerReader;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

export function resolvePaseoHome(environment: NodeJS.ProcessEnv = process.env): string {
  // Совпадает с правилом Paseo: PASEO_HOME либо ~/.paseo.
  // Источник: https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/paseo-home.ts
  return resolve(expandHome(environment.PASEO_HOME ?? "~/.paseo"));
}

export function getLedgerPath(workspaceId: string, paseoHome = resolvePaseoHome()): string {
  const validatedWorkspaceId = workspaceIdSchema.parse(workspaceId);
  const filename = `${createHash("sha256").update(validatedWorkspaceId).digest("hex")}.json`;
  return join(
    resolve(paseoHome),
    "plugin-data",
    "paseo-openspec-orchestrator",
    "activity",
    filename,
  );
}

function initialProjection(): OrchestratorProjection {
  return {
    change: null,
    lifecycle: { status: "idle", availableCommand: "start" },
    currentAction: null,
    history: [],
  };
}

function cloneProjection(projection: OrchestratorProjection): OrchestratorProjection {
  return {
    change: projection.change ? { ...projection.change } : null,
    lifecycle: { ...projection.lifecycle },
    currentAction: projection.currentAction
      ? { ...projection.currentAction, links: projection.currentAction.links.map((link) => ({ ...link })) }
      : null,
    history: projection.history.map((action) => ({
      ...action,
      links: action.links.map((link) => ({ ...link })),
    })),
  };
}

function cloneCheckpoint(checkpoint: WorkflowCheckpoint): WorkflowCheckpoint {
  return workflowCheckpointSchema.parse({
    ...checkpoint,
    state: { ...checkpoint.state },
  });
}

function snapshotOf(ledger: WorkspaceLedger): OrchestratorSnapshot {
  return orchestratorSnapshotSchema.parse({
    workspaceId: ledger.workspaceId,
    revision: String(ledger.revision),
    ...cloneProjection(ledger.projection),
    persistence: { ...ledger.persistence },
  });
}

function persistedOf(ledger: WorkspaceLedger): PersistedLedger {
  return persistedLedgerSchema.parse({
    version: LEDGER_VERSION,
    workspaceId: ledger.workspaceId,
    revision: ledger.revision,
    ...cloneProjection(ledger.projection),
    checkpoint: ledger.checkpoint,
  });
}

function parsePersistedLedger(
  source: string,
  workspaceId: string,
): { revision: number; projection: OrchestratorProjection; checkpoint: WorkflowCheckpoint | null } {
  const persisted = persistedLedgerSchema.parse(JSON.parse(source) as unknown);
  if (persisted.workspaceId !== workspaceId) {
    throw new Error("Ledger принадлежит другой рабочей области");
  }

  const {
    version: _version,
    workspaceId: _workspaceId,
    revision,
    checkpoint,
    ...projection
  } = persisted;
  const validatedSnapshot = orchestratorSnapshotSchema.parse({
    workspaceId,
    revision: String(revision),
    ...projection,
    persistence: { status: "ready" },
  });
  return {
    revision,
    projection: cloneProjection(validatedSnapshot),
    checkpoint: checkpoint ? cloneCheckpoint(checkpoint) : null,
  };
}

function createWorkspaceLedger(
  workspaceId: string,
  options: {
    revision?: number;
    projection?: OrchestratorProjection;
    checkpoint?: WorkflowCheckpoint | null;
    persistence?: OrchestratorSnapshot["persistence"];
    writesBlocked?: boolean;
    readRecoveryPending?: boolean;
  } = {},
): WorkspaceLedger {
  return {
    workspaceId,
    revision: options.revision ?? 0,
    projection: options.projection ?? initialProjection(),
    checkpoint: options.checkpoint ? cloneCheckpoint(options.checkpoint) : null,
    checkpointDirty: false,
    clearDirty: false,
    persistence: options.persistence ?? { status: "ready" },
    writesBlocked: options.writesBlocked ?? false,
    readRecoveryPending: options.readRecoveryPending ?? false,
    waiters: new Set(),
    writeQueue: Promise.resolve(),
    writeRequested: false,
    writeScheduled: false,
  };
}

async function writePrivateJson(path: string, value: PersistedLedger): Promise<void> {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_LEDGER_BYTES) {
    throw new Error("Ledger превысил допустимый размер файла");
  }

  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await file.writeFile(serialized, { encoding: "utf8" });
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temporaryPath, path);
    temporaryCreated = false;
    await chmod(path, 0o600);

    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function readBoundedText(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_LEDGER_BYTES) {
      throw new Error("Ledger имеет недопустимый размер или тип");
    }

    const buffer = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== buffer.length) throw new Error("Ledger изменился во время чтения");
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}

export class OrchestratorLedger {
  readonly #paseoHome: string;
  readonly #waitDurationMs: number;
  readonly #maximumWaiters: number;
  readonly #maximumTotalWaiters: number;
  readonly #writer: LedgerWriter;
  readonly #reader: LedgerReader;
  readonly #ledgers = new Map<string, WorkspaceLedger>();
  readonly #opening = new Map<string, Promise<WorkspaceLedger>>();
  #waiterCount = 0;

  constructor(options: OrchestratorLedgerOptions = {}) {
    this.#paseoHome = resolve(options.paseoHome ?? resolvePaseoHome());
    this.#waitDurationMs = options.waitDurationMs ?? ORCHESTRATOR_WAIT_MS;
    this.#maximumWaiters = options.maximumWaiters ?? MAX_WORKSPACE_WAITERS;
    this.#maximumTotalWaiters = options.maximumTotalWaiters ?? MAX_TOTAL_WAITERS;
    this.#writer = options.writer ?? writePrivateJson;
    this.#reader = options.reader ?? readBoundedText;
  }

  has(workspaceId: string): boolean {
    return this.#ledgers.has(workspaceId);
  }

  async open(workspaceId: string): Promise<OrchestratorSnapshot> {
    const validatedWorkspaceId = workspaceIdSchema.parse(workspaceId);
    const existing = this.#ledgers.get(validatedWorkspaceId);
    if (existing) return snapshotOf(existing);

    const inProgress = this.#opening.get(validatedWorkspaceId);
    if (inProgress) return snapshotOf(await inProgress);

    const opening = this.#load(validatedWorkspaceId);
    this.#opening.set(validatedWorkspaceId, opening);
    try {
      const ledger = await opening;
      this.#ledgers.set(validatedWorkspaceId, ledger);
      return snapshotOf(ledger);
    } finally {
      this.#opening.delete(validatedWorkspaceId);
    }
  }

  get(workspaceId: string): OrchestratorSnapshot {
    const ledger = this.#require(workspaceId);
    return snapshotOf(ledger);
  }

  getWorkflowCheckpoint(workspaceId: string): WorkflowCheckpoint | null {
    const ledger = this.#require(workspaceId);
    return ledger.checkpoint ? cloneCheckpoint(ledger.checkpoint) : null;
  }

  /**
   * Сохраняет checkpoint отдельно от публичной проекции.
   * Revision UI не меняется: checkpoint — внутренний курс workflow, а не новое
   * пользовательское событие. Вызывающий код должен дождаться flush().
   */
  setWorkflowCheckpoint(workspaceId: string, checkpoint: WorkflowCheckpoint | null): void {
    const ledger = this.#require(workspaceId);
    ledger.checkpoint = checkpoint ? cloneCheckpoint(checkpoint) : null;
    ledger.checkpointDirty = true;
    this.#schedulePersistence(ledger);
  }

  async saveWorkflowCheckpoint(
    workspaceId: string,
    checkpoint: WorkflowCheckpoint | null,
  ): Promise<void> {
    this.setWorkflowCheckpoint(workspaceId, checkpoint);
    await this.flush(workspaceId);
    const persistence = this.#require(workspaceId).persistence;
    if (persistence.status === "degraded") {
      throw new Error("Не удалось надёжно сохранить checkpoint workflow");
    }
  }

  /** Полностью удаляет пользовательскую историю и внутренний checkpoint. */
  clear(workspaceId: string): OrchestratorSnapshot {
    const ledger = this.#require(workspaceId);
    // Явный reset — единственная операция, которая может заменить
    // повреждённый ledger. Обычные обновления по-прежнему оставляют такой
    // файл без изменений до решения пользователя.
    ledger.writesBlocked = false;
    ledger.readRecoveryPending = false;
    ledger.persistence = { status: "ready" };

    const nextRevision = ledger.revision + 1;
    const nextSnapshot = orchestratorSnapshotSchema.parse({
      workspaceId: ledger.workspaceId,
      revision: String(nextRevision),
      ...initialProjection(),
      persistence: ledger.persistence,
    });
    ledger.revision = nextRevision;
    ledger.projection = cloneProjection(nextSnapshot);
    ledger.checkpoint = null;
    ledger.checkpointDirty = true;
    ledger.clearDirty = true;
    this.#notify(ledger);
    this.#schedulePersistence(ledger);
    return snapshotOf(ledger);
  }

  update(
    workspaceId: string,
    updater: (projection: Readonly<OrchestratorProjection>) => OrchestratorProjection,
  ): OrchestratorSnapshot {
    const ledger = this.#require(workspaceId);
    const nextProjection = updater(cloneProjection(ledger.projection));
    const nextRevision = ledger.revision + 1;
    const nextSnapshot = orchestratorSnapshotSchema.parse({
      workspaceId: ledger.workspaceId,
      revision: String(nextRevision),
      ...nextProjection,
      persistence: ledger.persistence,
    });

    ledger.revision = nextRevision;
    ledger.projection = cloneProjection(nextSnapshot);
    this.#notify(ledger);
    this.#schedulePersistence(ledger);
    return snapshotOf(ledger);
  }

  async wait(workspaceId: string, revision: string): Promise<WaitResult> {
    const ledger = this.#require(workspaceId);
    const current = snapshotOf(ledger);
    if (current.revision !== revision) {
      return { status: "changed", snapshot: current };
    }

    if (
      ledger.waiters.size >= this.#maximumWaiters ||
      this.#waiterCount >= this.#maximumTotalWaiters
    ) {
      throw new Error("Слишком много одновременных ожиданий состояния оркестратора");
    }

    return new Promise<WaitResult>((resolveWait) => {
      const waiter: Waiter = {
        timer: setTimeout(() => {
          this.#settleWaiter(ledger, waiter, {
            status: "unchanged",
            revision: snapshotOf(ledger).revision,
          });
        }, this.#waitDurationMs),
        resolve: resolveWait,
        settled: false,
      };
      ledger.waiters.add(waiter);
      this.#waiterCount += 1;
    });
  }

  async close(): Promise<void> {
    for (const ledger of this.#ledgers.values()) {
      for (const waiter of ledger.waiters) {
        this.#settleWaiter(ledger, waiter, {
          status: "unchanged",
          revision: String(ledger.revision),
        });
      }
    }
    await Promise.all([...this.#ledgers.values()].map((ledger) => ledger.writeQueue));
  }

  async flush(workspaceId?: string): Promise<void> {
    if (workspaceId) {
      await this.#require(workspaceId).writeQueue;
      return;
    }
    await Promise.all([...this.#ledgers.values()].map((ledger) => ledger.writeQueue));
  }

  async #load(workspaceId: string): Promise<WorkspaceLedger> {
    const path = getLedgerPath(workspaceId, this.#paseoHome);
    let source: string;
    try {
      source = await this.#reader(path);
    } catch (error) {
      if (isMissingFile(error)) {
        return createWorkspaceLedger(workspaceId);
      }

      console.error("[OpenSpec] Ledger временно недоступен для чтения", {
        path,
        error,
      });
      return createWorkspaceLedger(workspaceId, {
        persistence: {
          status: "degraded",
          message: "История на диске временно недоступна; изменения хранятся в памяти",
        },
        readRecoveryPending: true,
      });
    }

    try {
      const loaded = parsePersistedLedger(source, workspaceId);
      return createWorkspaceLedger(workspaceId, loaded);
    } catch (error) {
      console.error("[OpenSpec] Повреждённый ledger оставлен без изменений", {
        path,
        error,
      });
      return createWorkspaceLedger(workspaceId, {
        persistence: {
          status: "degraded",
          message: "История на диске повреждена; запись отключена, исходный файл сохранён",
        },
        writesBlocked: true,
      });
    }
  }

  #require(workspaceId: string): WorkspaceLedger {
    const validatedWorkspaceId = workspaceIdSchema.parse(workspaceId);
    const ledger = this.#ledgers.get(validatedWorkspaceId);
    if (!ledger) {
      throw new Error("Состояние оркестратора для рабочей области не загружено");
    }
    return ledger;
  }

  #notify(ledger: WorkspaceLedger): void {
    if (ledger.waiters.size === 0) return;
    const result: WaitResult = { status: "changed", snapshot: snapshotOf(ledger) };
    for (const waiter of ledger.waiters) this.#settleWaiter(ledger, waiter, result);
  }

  #settleWaiter(ledger: WorkspaceLedger, waiter: Waiter, result: WaitResult): void {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    ledger.waiters.delete(waiter);
    this.#waiterCount -= 1;
    waiter.resolve(result);
  }

  #schedulePersistence(ledger: WorkspaceLedger): void {
    if (ledger.writesBlocked) return;
    ledger.writeRequested = true;
    if (ledger.writeScheduled) return;
    ledger.writeScheduled = true;

    const drainWrites = async () => {
      try {
        while (ledger.writeRequested) {
          ledger.writeRequested = false;
          await this.#persist(ledger);
        }
      } finally {
        ledger.writeScheduled = false;
        if (ledger.writeRequested) this.#schedulePersistence(ledger);
      }
    };
    ledger.writeQueue = ledger.writeQueue.then(
      drainWrites,
      drainWrites,
    );
  }

  async #persist(ledger: WorkspaceLedger): Promise<void> {
    try {
      if (ledger.readRecoveryPending && !(await this.#recoverBeforeWrite(ledger))) return;
      if (ledger.writesBlocked) return;
      await this.#writer(getLedgerPath(ledger.workspaceId, this.#paseoHome), persistedOf(ledger));
      if (ledger.persistence.status === "degraded") {
        ledger.persistence = { status: "ready" };
        ledger.revision += 1;
        this.#notify(ledger);
        await this.#writer(getLedgerPath(ledger.workspaceId, this.#paseoHome), persistedOf(ledger));
      }
    } catch (error) {
      console.error("[OpenSpec] Не удалось сохранить ledger оркестратора", {
        workspaceId: ledger.workspaceId,
        error,
      });
      if (
        ledger.persistence.status === "ready" ||
        ledger.persistence.message !== "История временно хранится только в памяти"
      ) {
        ledger.persistence = {
          status: "degraded",
          message: "История временно хранится только в памяти",
        };
        ledger.revision += 1;
        this.#notify(ledger);
      }
    }
  }

  async #recoverBeforeWrite(ledger: WorkspaceLedger): Promise<boolean> {
    const path = getLedgerPath(ledger.workspaceId, this.#paseoHome);
    let source: string;
    try {
      source = await this.#reader(path);
    } catch (error) {
      if (isMissingFile(error)) {
        ledger.readRecoveryPending = false;
        return true;
      }
      throw error;
    }

    let loaded: ReturnType<typeof parsePersistedLedger>;
    try {
      loaded = parsePersistedLedger(source, ledger.workspaceId);
      const history = ledger.clearDirty
        ? ledger.projection.history
        : mergeRecoveredHistory(loaded.projection, ledger.projection, new Date());
      const revision = Math.max(loaded.revision, ledger.revision) + 1;
      const recovered = orchestratorSnapshotSchema.parse({
        workspaceId: ledger.workspaceId,
        revision: String(revision),
        ...ledger.projection,
        history,
        persistence: ledger.persistence,
      });
      ledger.revision = revision;
      ledger.projection = cloneProjection(recovered);
      if (!ledger.checkpointDirty) {
        ledger.checkpoint = loaded.checkpoint;
      }
      ledger.checkpointDirty = true;
      ledger.clearDirty = false;
      ledger.readRecoveryPending = false;
      this.#notify(ledger);
      return true;
    } catch (error) {
      console.error("[OpenSpec] Повреждённый ledger оставлен без изменений", {
        path,
        error,
      });
      ledger.readRecoveryPending = false;
      ledger.writesBlocked = true;
      ledger.persistence = {
        status: "degraded",
        message: "История на диске повреждена; запись отключена, исходный файл сохранён",
      };
      ledger.revision += 1;
      this.#notify(ledger);
      return false;
    }
  }
}

function mergeRecoveredHistory(
  persisted: OrchestratorProjection,
  inMemory: OrchestratorProjection,
  now: Date,
): CompletedAction[] {
  const recovered = [...persisted.history];
  if (persisted.currentAction) {
    recovered.push({
      ...persisted.currentAction,
      finishedAt: new Date(
        Math.max(now.getTime(), Date.parse(persisted.currentAction.startedAt)),
      ).toISOString(),
      outcome: "cancelled",
    });
  }

  const identifiers = new Set(recovered.map(({ id }) => id));
  for (const action of inMemory.history) {
    if (identifiers.has(action.id)) {
      throw new Error("Восстанавливаемые истории содержат одинаковые идентификаторы");
    }
    identifiers.add(action.id);
    recovered.push(action);
  }
  if (inMemory.currentAction && identifiers.has(inMemory.currentAction.id)) {
    throw new Error("Текущее действие конфликтует с восстанавливаемой историей");
  }

  return recovered.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
