import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { runBoundedCommand, type BoundedCommandRunner } from "./bounded-command.ts";
import {
  createChangeArtifactStatusGateway,
  type ChangeArtifactStatusGateway,
} from "./change-artifact-status.ts";
import {
  applyInstructionsSchema,
  taskDescriptionSchema,
  taskIdSchema,
  taskNumberSchema,
  type ApplyInstructions,
} from "./change-task-model.ts";
import { runWorkspaceMiseCommand } from "./mise-toolchain.ts";
import { openSpecChangeIdSchema } from "./openspec-change.ts";

const MAX_PLAN_BYTES = 256 * 1024;
const MAX_PHASES = 256;
const TASK_NUMBER_PREFIX = /^(\d+(?:\.\d+)+(?:[A-Za-z]+)?)(?=\s|$)/u;
const PHASE_HEADING = /^\s{0,3}##[ \t]+(?:Phase|Фаза)[ \t]+([1-9][0-9]*)\b/iu;

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const phaseReferenceSchema = z
  .object({
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strip();

export const taskFingerprintSchema = z
  .object({
    id: taskIdSchema,
    number: taskNumberSchema,
    description: taskDescriptionSchema,
    done: z.boolean(),
    fingerprint: fingerprintSchema,
  })
  .strict();

export const phaseProgressSchema = z
  .object({
    phases: z.array(phaseReferenceSchema).max(MAX_PHASES),
    tasks: z.array(taskFingerprintSchema).max(4_096),
    nextImplementationRun: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((progress, context) => {
    const phaseNumbers = new Set<number>();
    progress.phases.forEach((phase, index) => {
      if (phaseNumbers.has(phase.number)) {
        context.addIssue({
          code: "custom",
          path: ["phases", index, "number"],
          message: "Сохранённые номера фаз не должны повторяться",
        });
      }
      phaseNumbers.add(phase.number);
    });
    const knownPhases = new Set(progress.phases.map(({ number }) => number));
    const ids = new Set<string>();
    const numbers = new Set<string>();
    progress.tasks.forEach((task, index) => {
      const normalizedNumber = task.number.toLowerCase();
      const phaseSegment = task.number.split(".")[0]!;
      const phaseNumber = Number(phaseSegment);
      if (ids.has(task.id) || numbers.has(normalizedNumber)) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index],
          message: "Сохранённые fingerprints задач содержат повторяющийся ID или номер",
        });
      }
      if (
        !Number.isSafeInteger(phaseNumber) ||
        String(phaseNumber) !== phaseSegment ||
        !knownPhases.has(phaseNumber)
      ) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "number"],
          message: "Сохранённая задача ссылается на неизвестную фазу",
        });
      }
      if (task.fingerprint !== phaseTaskFingerprint(task.id, task.number, task.description)) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "fingerprint"],
          message: "Fingerprint задачи не соответствует её ID, номеру и описанию",
        });
      }
      ids.add(task.id);
      numbers.add(normalizedNumber);
    });
  });

export type PhaseProgress = z.infer<typeof phaseProgressSchema>;

export interface ParsedPhase {
  readonly number: number;
}

export interface PhaseTaskSnapshot {
  readonly id: string;
  readonly number: string;
  readonly description: string;
  readonly done: boolean;
  readonly phaseNumber: number;
  readonly fingerprint: string;
}

export interface PhaseWorkSnapshot {
  readonly phases: readonly ParsedPhase[];
  readonly tasks: readonly PhaseTaskSnapshot[];
  readonly schemaName: string;
  readonly planPath: string;
  readonly taskArtifactPaths: readonly string[];
}

export type PhaseWorkDecision =
  | {
      readonly kind: "implementation-required";
      readonly phaseNumber: number;
      readonly runNumber: number;
      readonly progress: PhaseProgress;
      readonly snapshot: PhaseWorkSnapshot;
    }
  | {
      readonly kind: "planning-required";
      readonly phaseNumber: number;
      readonly progress: PhaseProgress;
      readonly snapshot: PhaseWorkSnapshot;
    }
  | {
      readonly kind: "change-complete";
      readonly progress: PhaseProgress;
      readonly snapshot: PhaseWorkSnapshot;
    };

export interface PhaseWorkService {
  inspect(
    workspaceDirectory: string,
    changeId: string,
    previous: PhaseProgress | null,
    signal?: AbortSignal,
  ): Promise<PhaseWorkDecision>;
}

export interface PhaseWorkServiceOptions {
  readonly command?: BoundedCommandRunner;
  readonly statusGateway?: ChangeArtifactStatusGateway;
  readonly resolveRealPath?: typeof realpath;
  readonly inspectPath?: typeof lstat;
  readonly readPlan?: typeof readFile;
}

export class PhaseWorkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhaseWorkError";
  }
}

export function createPhaseWorkService(
  options: PhaseWorkServiceOptions = {},
): PhaseWorkService {
  const command = options.command ?? runBoundedCommand;
  const resolveRealPath = options.resolveRealPath ?? realpath;
  const inspectPath = options.inspectPath ?? lstat;
  const readPlan = options.readPlan ?? readFile;
  const statusGateway = options.statusGateway ?? createChangeArtifactStatusGateway({
    command,
    resolveRealPath,
  });

  return {
    async inspect(workspaceDirectory, changeIdInput, previousInput, signal) {
      const changeId = openSpecChangeIdSchema.parse(changeIdInput);
      const previous = previousInput === null
        ? null
        : phaseProgressSchema.parse(previousInput);
      const status = await statusGateway.read(workspaceDirectory, changeId, signal);
      if (!status.isPlanningComplete) {
        throw new PhaseWorkError(
          `Planning-артефакты change «${changeId}» ещё не завершены`,
        );
      }
      const planPath = await resolveSafePlanPath(
        status.changeRoot,
        status.gitRoot,
        resolveRealPath,
        inspectPath,
      );
      const plan = await readBoundedUtf8Plan(planPath, inspectPath, readPlan);
      const phases = parsePhasedPlan(plan);
      const instructions = await readApplyInstructions(
        command,
        workspaceDirectory,
        changeId,
        signal,
      );
      if (instructions.schemaName !== status.schemaName) {
        throw new PhaseWorkError(
          "OpenSpec status и apply-инструкции относятся к разным schema",
        );
      }
      const tasks = parsePhaseTasks(instructions, phases);
      const taskArtifactPaths = status.applyRequires.flatMap((artifactId) => {
        const artifact = status.artifactPaths.get(artifactId);
        if (!artifact) {
          throw new PhaseWorkError(
            `OpenSpec не вернул пути обязательного apply-артефакта «${artifactId}»`,
          );
        }
        return artifact.existingOutputPaths;
      });
      if (taskArtifactPaths.length === 0) {
        throw new PhaseWorkError("OpenSpec не вернул task-файл для apply");
      }
      const snapshot: PhaseWorkSnapshot = Object.freeze({
        phases: Object.freeze(phases),
        tasks: Object.freeze(tasks),
        schemaName: status.schemaName,
        planPath,
        taskArtifactPaths: Object.freeze([...new Set(taskArtifactPaths)]),
      });
      return classifyPhaseWork(snapshot, previous);
    },
  };
}

export function parsePhasedPlan(markdown: string): readonly ParsedPhase[] {
  const normalized = markdown.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const phases: ParsedPhase[] = [];
  const seen = new Set<number>();
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (marker === fence.marker && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const match = PHASE_HEADING.exec(line);
    if (!match?.[1]) continue;
    const number = Number(match[1]);
    if (seen.has(number) || phases.length >= MAX_PHASES) continue;
    seen.add(number);
    phases.push(Object.freeze({ number }));
  }
  return Object.freeze(phases);
}

export function classifyPhaseWork(
  snapshot: PhaseWorkSnapshot,
  previousInput: PhaseProgress | null,
): PhaseWorkDecision {
  const previous = previousInput === null ? null : phaseProgressSchema.parse(previousInput);
  assertHistoricalProgress(snapshot, previous);
  const tasksByPhase = new Map<number, PhaseTaskSnapshot[]>();
  for (const phase of snapshot.phases) tasksByPhase.set(phase.number, []);
  const taskIds = new Set<string>();
  const taskNumbers = new Set<string>();
  for (const task of snapshot.tasks) {
    const bucket = tasksByPhase.get(task.phaseNumber);
    if (!bucket) {
      throw new PhaseWorkError(
        `Задача ${task.number} ссылается на неизвестную Phase ${task.phaseNumber}`,
      );
    }
    const normalizedNumber = task.number.toLowerCase();
    if (taskIds.has(task.id) || taskNumbers.has(normalizedNumber)) {
      throw new PhaseWorkError(`Повторяется ID или номер задачи ${task.number}`);
    }
    taskIds.add(task.id);
    taskNumbers.add(normalizedNumber);
    bucket.push(task);
  }

  let missingPhase: number | null = null;
  for (const phase of snapshot.phases) {
    const tasks = tasksByPhase.get(phase.number)!;
    if (tasks.length === 0) {
      missingPhase ??= phase.number;
      continue;
    }
    if (missingPhase !== null) {
      throw new PhaseWorkError(
        `Phase ${phase.number} содержит задачи после нераспланированной Phase ${missingPhase}`,
      );
    }
  }

  const progress = phaseProgressSchema.parse({
    phases: snapshot.phases.map(({ number }) => ({ number })),
    tasks: snapshot.tasks.map(({ id, number, description, done, fingerprint }) => ({
      id,
      number,
      description,
      done,
      fingerprint,
    })),
    nextImplementationRun: previous?.nextImplementationRun ?? 1,
  });
  const phaseOrder = new Map(
    snapshot.phases.map(({ number }, index) => [number, index]),
  );
  const unfinished = snapshot.tasks
    .filter(({ done }) => !done)
    .sort(
      (left, right) =>
        phaseOrder.get(left.phaseNumber)! - phaseOrder.get(right.phaseNumber)!,
    )[0];
  if (unfinished) {
    return {
      kind: "implementation-required",
      phaseNumber: unfinished.phaseNumber,
      runNumber: progress.nextImplementationRun,
      progress,
      snapshot,
    };
  }
  if (missingPhase !== null) {
    return { kind: "planning-required", phaseNumber: missingPhase, progress, snapshot };
  }
  return { kind: "change-complete", progress, snapshot };
}

function parsePhaseTasks(
  instructions: ApplyInstructions,
  phases: readonly ParsedPhase[],
): readonly PhaseTaskSnapshot[] {
  const completed = instructions.tasks.filter(({ done }) => done).length;
  if (
    instructions.progress.total !== instructions.tasks.length ||
    instructions.progress.complete !== completed ||
    instructions.progress.remaining !== instructions.tasks.length - completed ||
    (instructions.state === "all_done" && instructions.progress.remaining !== 0) ||
    (instructions.state === "ready" && instructions.progress.remaining === 0)
  ) {
    throw new PhaseWorkError("OpenSpec вернул противоречивый progress задач");
  }
  if (instructions.state === "blocked") {
    throw new PhaseWorkError(`OpenSpec apply заблокирован: ${instructions.instruction}`);
  }
  const knownPhases = new Set(phases.map(({ number }) => number));
  const ids = new Set<string>();
  const numbers = new Set<string>();
  return instructions.tasks.map((task) => {
    const match = TASK_NUMBER_PREFIX.exec(task.description);
    if (!match?.[1]) {
      throw new PhaseWorkError(
        `OpenSpec-задача «${task.description}» не начинается с номера вида N.1`,
      );
    }
    const number = taskNumberSchema.parse(match[1]);
    const phaseSegment = number.split(".")[0]!;
    const phaseNumber = Number(phaseSegment);
    if (!Number.isSafeInteger(phaseNumber) || String(phaseNumber) !== phaseSegment) {
      throw new PhaseWorkError(`Задача ${number} содержит некорректный номер фазы`);
    }
    if (!knownPhases.has(phaseNumber)) {
      throw new PhaseWorkError(
        `Задача ${number} ссылается на неизвестную Phase ${phaseNumber}`,
      );
    }
    if (ids.has(task.id)) throw new PhaseWorkError(`Повторяется внутренний ID задачи «${task.id}»`);
    const normalizedNumber = number.toLowerCase();
    if (numbers.has(normalizedNumber)) throw new PhaseWorkError(`Повторяется номер задачи ${number}`);
    ids.add(task.id);
    numbers.add(normalizedNumber);
    return Object.freeze({
      id: task.id,
      number,
      description: task.description,
      done: task.done,
      phaseNumber,
      fingerprint: phaseTaskFingerprint(task.id, number, task.description),
    });
  });
}

function assertHistoricalProgress(
  snapshot: PhaseWorkSnapshot,
  previous: PhaseProgress | null,
): void {
  if (!previous) return;
  if (snapshot.tasks.length < previous.tasks.length) {
    throw new PhaseWorkError("Из OpenSpec удалена ранее известная задача");
  }
  previous.tasks.forEach((known, index) => {
    const current = snapshot.tasks[index];
    if (
      !current ||
      current.id !== known.id ||
      current.number !== known.number ||
      current.fingerprint !== known.fingerprint
    ) {
      throw new PhaseWorkError(
        `Список задач перестал сохранять точный префикс на позиции ${index + 1}`,
      );
    }
    if (known.done && !current.done) {
      throw new PhaseWorkError(`Завершённая задача ${known.number} снова открыта`);
    }
  });
  for (const added of snapshot.tasks.slice(previous.tasks.length)) {
    if (added.done) {
      throw new PhaseWorkError(`Новая задача ${added.number} уже отмечена завершённой`);
    }
  }
}

async function readApplyInstructions(
  command: BoundedCommandRunner,
  workspaceDirectory: string,
  changeId: string,
  signal?: AbortSignal,
): Promise<ApplyInstructions> {
  try {
    const { stdout } = await runWorkspaceMiseCommand(
      command,
      workspaceDirectory,
      "openspec",
      ["instructions", "apply", "--change", changeId, "--json"],
      signal,
    );
    const instructions = applyInstructionsSchema.parse(JSON.parse(stdout) as unknown);
    if (instructions.changeName !== changeId) throw new Error("Другой change");
    return instructions;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new PhaseWorkError(`Не удалось прочитать apply-инструкции change «${changeId}»`);
  }
}

async function resolveSafePlanPath(
  changeRoot: string,
  gitRoot: string,
  resolveRealPath: typeof realpath,
  inspectPath: typeof lstat,
): Promise<string> {
  const candidate = resolve(changeRoot, "plan.md");
  assertContained(changeRoot, candidate, "plan.md");
  let info;
  try {
    info = await inspectPath(candidate);
  } catch {
    throw new PhaseWorkError("Обязательный файл plan.md отсутствует");
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new PhaseWorkError("plan.md должен быть обычным файлом, а не symlink");
  }
  let concrete: string;
  try {
    concrete = await resolveRealPath(candidate);
  } catch {
    throw new PhaseWorkError("Не удалось разрешить безопасный путь plan.md");
  }
  assertContained(changeRoot, concrete, "plan.md");
  assertContained(gitRoot, concrete, "plan.md");
  return concrete;
}

async function readBoundedUtf8Plan(
  path: string,
  inspectPath: typeof lstat,
  readPlan: typeof readFile,
): Promise<string> {
  const info = await inspectPath(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PLAN_BYTES) {
    throw new PhaseWorkError(`plan.md должен быть обычным файлом не больше ${MAX_PLAN_BYTES} байт`);
  }
  const bytes = await readPlan(path);
  if (bytes.byteLength > MAX_PLAN_BYTES) throw new PhaseWorkError("plan.md слишком велик");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PhaseWorkError("plan.md содержит некорректный UTF-8");
  }
}

function assertContained(root: string, candidate: string, label: string): void {
  const path = relative(root, candidate);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new PhaseWorkError(`${label} находится за пределами допустимого каталога`);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function phaseTaskFingerprint(
  id: string,
  number: string,
  description: string,
): string {
  return digest(JSON.stringify([id, number, description]));
}
